import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { Type } from 'typebox';

declare module 'fastify' {
  interface FastifyRequest {
    problemCode: string | null;
    errorType: string | null;
  }
}

const SAFE_ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'AggregateError']);

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return 'NonErrorThrow';
  try {
    return SAFE_ERROR_TYPES.has(error.name) ? error.name : 'Error';
  } catch {
    return 'Error';
  }
}

export const problemSchema = Type.Object({
  type: Type.String(), title: Type.String(), status: Type.Integer(),
  code: Type.Union(['invalid_input', 'invalid_cursor', 'invalid_api_key', 'not_found', 'rate_limited', 'internal_error'].map((code) => Type.Literal(code))),
  detail: Type.String(),
});
export const problemResponseSchema = {
  description: 'A stable error response in Problem Details format.',
  content: { 'application/problem+json': { schema: problemSchema } },
};
export function problem(reply: FastifyReply, status: number, code: string, detail: string) {
  reply.request.problemCode = code;
  const title = status === 404 ? 'Not Found' : status === 401 ? 'Unauthorized' : status === 400 ? 'Bad Request'
    : status === 429 ? 'Too Many Requests' : 'Internal Server Error';
  return reply.code(status).type('application/problem+json').send({ type: 'about:blank', title, status, code, detail });
}
export function installProblemHandler(app: FastifyInstance): void {
  app.decorateRequest('problemCode', null);
  app.decorateRequest('errorType', null);
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/v1/')) return;
    route.schema = {
      ...route.schema,
      response: { ...(route.schema?.response as Record<string, unknown> | undefined), 500: problemResponseSchema },
    };
  });
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error.validation || error.statusCode === 400) return problem(reply, 400, 'invalid_input', 'The request input is invalid.');
    reply.request.errorType = safeErrorType(error);
    return problem(reply, 500, 'internal_error', 'An unexpected error occurred.');
  });
  app.setNotFoundHandler((_request, reply) => problem(reply, 404, 'not_found', 'The requested resource was not found.'));
}
