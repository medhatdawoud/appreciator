import type { WebConfig } from '@appreciator/shared';
import type { FastifyInstance } from 'fastify';

/**
 * What the landing page and dashboard need to boot, served by the API so
 * the static pages carry no deployment-specific values of their own.
 *
 * `no-store` because it changes with the environment (sign-in switched on, a
 * new demo key after a fresh database) and is too small to be worth caching.
 */
export async function webRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/web/config.json',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['apiUrl', 'demoKey', 'signInEnabled', 'repoUrl'],
            properties: {
              apiUrl: { type: 'string' },
              demoKey: { type: ['string', 'null'] },
              signInEnabled: { type: 'boolean' },
              repoUrl: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply): Promise<WebConfig> => {
      void reply.header('cache-control', 'no-store');
      return {
        apiUrl: app.appConfig.publicBaseUrl,
        demoKey: app.demoPublicKey,
        signInEnabled: app.appConfig.signInEnabled,
        repoUrl: app.appConfig.repoUrl,
      };
    },
  );
}
