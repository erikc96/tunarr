import { DeviceSlugRegex } from '@/db/ClientDeviceDB.js';
import { QualityProfileNames } from '@/stream/qualityProfiles.js';
import type { RouterPluginAsyncCallback } from '@/types/serverType.js';
import z from 'zod/v4';

// Viewing devices and their app passwords. The password is returned once,
// when the device is created.
export const clientDevicesApiRouter: RouterPluginAsyncCallback = async (
  fastify,
  // eslint-disable-next-line @typescript-eslint/require-await
) => {
  fastify.get(
    '/client-devices',
    { schema: { tags: ['Settings'] } },
    async (req, res) => res.send(await req.serverCtx.clientDeviceDB.list()),
  );

  fastify.post(
    '/client-devices',
    {
      schema: {
        tags: ['Settings'],
        body: z.object({
          name: z.string().min(1).max(80),
          slug: z.string().regex(DeviceSlugRegex),
          profile: z.enum(QualityProfileNames),
        }),
      },
    },
    async (req, res) => {
      try {
        const { device, password } = await req.serverCtx.clientDeviceDB.create(
          req.body.name,
          req.body.slug,
          req.body.profile,
        );
        return res.status(201).send({ device, password });
      } catch {
        return res.status(409).send({ error: 'That slug is already taken' });
      }
    },
  );

  fastify.patch(
    '/client-devices/:id',
    {
      schema: {
        tags: ['Settings'],
        params: z.object({ id: z.string() }),
        body: z.object({
          name: z.string().min(1).max(80).optional(),
          profile: z.enum(QualityProfileNames).optional(),
        }),
      },
    },
    async (req, res) => {
      await req.serverCtx.clientDeviceDB.update(req.params.id, req.body);
      return res.status(204).send();
    },
  );

  fastify.delete(
    '/client-devices/:id',
    {
      schema: { tags: ['Settings'], params: z.object({ id: z.string() }) },
    },
    async (req, res) => {
      await req.serverCtx.clientDeviceDB.revoke(req.params.id);
      return res.status(204).send();
    },
  );
};
