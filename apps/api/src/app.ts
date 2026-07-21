import { Hono } from 'hono';
import { createYoga } from 'graphql-yoga';

import { schema } from './presentation/graphql/schema.js';

export const createApp = () => {
  const app = new Hono();
  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    maskedErrors: true,
  });

  app.get('/health', (context) => context.json({ status: 'ok' }));
  app.on(['GET', 'POST', 'OPTIONS'], '/graphql', (context) =>
    yoga.fetch(context.req.raw),
  );

  return app;
};

export type ApiApp = ReturnType<typeof createApp>;
