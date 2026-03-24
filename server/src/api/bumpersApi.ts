import type { RouterPluginAsyncCallback } from '@/types/serverType.js';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import {
  BumperPackListSchema,
  BumperPackSchema,
  CreateBumperPackRequestSchema,
} from '@tunarr/types/schemas';
import { z } from 'zod/v4';
import { container } from '../container.js';
import { BumperDB } from '../services/bumpers/BumperDB.js';
import { BumperScanner } from '../services/bumpers/BumperScanner.js';

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'BumpersApi',
});

export const bumpersApiRouter: RouterPluginAsyncCallback = async (fastify) => {
  // List all bumper packs
  fastify.get(
    '/bumpers/packs',
    {
      schema: {
        tags: ['Bumpers'],
        response: { 200: BumperPackListSchema },
      },
    },
    async (_req, res) => {
      const db = container.get(BumperDB);
      return res.send(await db.getPacks());
    },
  );

  // Get a specific bumper pack
  fastify.get(
    '/bumpers/packs/:packId',
    {
      schema: {
        tags: ['Bumpers'],
        params: z.object({ packId: z.string() }),
        response: {
          200: BumperPackSchema,
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      const db = container.get(BumperDB);
      const pack = await db.getPackById(req.params.packId);
      if (!pack) {
        return res.status(404).send({ error: 'Bumper pack not found' });
      }
      return res.send(pack);
    },
  );

  // Create a new bumper pack by scanning a directory
  fastify.post(
    '/bumpers/packs',
    {
      schema: {
        tags: ['Bumpers'],
        body: CreateBumperPackRequestSchema,
        response: {
          201: BumperPackSchema,
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      try {
        const scanner = container.get(BumperScanner);
        const pack = await scanner.createPack({
          name: req.body.name,
          directory: req.body.directory,
        });
        return res.status(201).send(pack);
      } catch (err: unknown) {
        logger.error(err, 'Error creating bumper pack');
        return res
          .status(500)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Rescan an existing bumper pack
  fastify.post(
    '/bumpers/packs/:packId/rescan',
    {
      schema: {
        tags: ['Bumpers'],
        params: z.object({ packId: z.string() }),
        response: {
          200: BumperPackSchema,
          404: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      try {
        const scanner = container.get(BumperScanner);
        const pack = await scanner.rescanPack(req.params.packId);
        return res.send(pack);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return res.status(404).send({ error: msg });
        }
        logger.error(err, 'Error rescanning bumper pack');
        return res.status(500).send({ error: msg });
      }
    },
  );

  // Delete a bumper pack
  fastify.delete(
    '/bumpers/packs/:packId',
    {
      schema: {
        tags: ['Bumpers'],
        params: z.object({ packId: z.string() }),
        response: {
          204: z.void(),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      const db = container.get(BumperDB);
      const deleted = await db.deletePack(req.params.packId);
      if (!deleted) {
        return res.status(404).send({ error: 'Bumper pack not found' });
      }
      return res.status(204).send();
    },
  );
};
