import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { Type } from 'typebox';

export const problemSchema = Type.Object({
  type: Type.String(), title: Type.String(), status: Type.Integer(), code: Type.String(), detail: Type.String(),
});
export function problem(reply: FastifyReply, status: number, code: string, detail: string) {
  return reply.code(status).type('application/problem+json').send({
    type: 'about:blank', title: status === 404 ? 'Not Found' : status === 401 ? 'Unauthorized' : status === 400 ? 'Bad Request' : 'Internal Server Error', status, code, detail,
  });
}
export function installProblemHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error.validation || error.statusCode === 400) return problem(reply, 400, 'invalid_input', 'The request input is invalid.');
    request.log.error({ err: error }, 'Request failed');
    return problem(reply, 500, 'internal_error', 'An unexpected error occurred.');
  });
  app.setNotFoundHandler((_request, reply) => problem(reply, 404, 'not_found', 'The requested resource was not found.'));
}
