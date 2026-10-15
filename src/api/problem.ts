import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { Type } from 'typebox';

declare module 'fastify' {
  interface FastifyRequest {
    problemCode: string | null;
  }
}

export const problemSchema = Type.Object({
  type: Type.String(), title: Type.String(), status: Type.Integer(), code: Type.String(), detail: Type.String(),
});
export function problem(reply: FastifyReply, status: number, code: string, detail: string) {
  reply.request.problemCode = code;
  return reply.code(status).type('application/problem+json').send({
    type: 'about:blank', title: status === 404 ? 'Not Found' : status === 401 ? 'Unauthorized' : status === 400 ? 'Bad Request' : 'Internal Server Error', status, code, detail,
  });
}
export function installProblemHandler(app: FastifyInstance): void {
  app.decorateRequest('problemCode', null);
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error.validation || error.statusCode === 400) return problem(reply, 400, 'invalid_input', 'The request input is invalid.');
    return problem(reply, 500, 'internal_error', 'An unexpected error occurred.');
  });
  app.setNotFoundHandler((_request, reply) => problem(reply, 404, 'not_found', 'The requested resource was not found.'));
}
