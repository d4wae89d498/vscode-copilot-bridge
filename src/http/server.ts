import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'http';
import { getBridgeConfig } from '../config';
import { state } from '../state';
import { isAuthorized } from './auth';
import { handleHealthCheck } from './routes/health';
import { handleModelsRequest } from './routes/models';
import { handleChatCompletion } from './routes/chat';
import { writeErrorResponse, writeNotFound, writeRateLimit, writeTokenRequired, writeUnauthorized } from './utils';
import { ensureOutput, verbose } from '../log';
import { updateStatus } from '../status';

export const startServer = async (): Promise<void> => {
  if (state.server) return;
  const config = getBridgeConfig();
  ensureOutput();

  const app = express();

  // Auth middleware - runs before all routes (except /health)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const path = req.url ?? '/';
    if (path === '/health') {
      return next();
    }
    const token = getBridgeConfig().token;
    if (!token) {
      if (config.verbose) {
        verbose('401 unauthorized: missing auth token');
      }
      writeTokenRequired(res);
      return;
    }
    if (!isAuthorized(req, token)) {
      writeUnauthorized(res);
      return;
    }
    next();
  });

  // Verbose logging middleware
  if (config.verbose) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      verbose(`${req.method} ${req.url}`);
      next();
    });
  }

  app.get('/health', async (_req: Request, res: Response) => {
    await handleHealthCheck(res, config.verbose);
  });

  app.get('/v1/models', async (_req: Request, res: Response) => {
    await handleModelsRequest(res);
  });

  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    // Rate limiting check
    if (state.activeRequests >= config.maxConcurrent) {
      if (config.verbose) {
        verbose(`429 throttled (active=${state.activeRequests}, max=${config.maxConcurrent})`);
      }
      writeRateLimit(res);
      return;
    }

    try {
      await handleChatCompletion(req, res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      writeErrorResponse(res, 500, msg || 'internal_error', 'server_error', 'internal_error');
    }
  });

  // 404 catch-all
  app.use((_req: Request, res: Response) => {
    writeNotFound(res);
  });

  // Error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    verbose(`HTTP error: ${msg}`);
    if (!res.headersSent) {
      writeErrorResponse(res, 500, msg || 'internal_error', 'server_error', 'internal_error');
    } else {
      try { res.end(); } catch {/* ignore */}
    }
  });

  await new Promise<void>((resolve, reject) => {
    try {
      const srv = app.listen(config.port, config.host, () => {
        state.server = srv as unknown as Server;
        updateStatus('start');
        resolve();
      });
      srv.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
};

export const stopServer = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    if (!state.server) return resolve();
    state.server.close(() => resolve());
  });
  state.server = undefined;
};
