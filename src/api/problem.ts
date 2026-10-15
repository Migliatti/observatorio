import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { Type } from 'typebox';

declare module 'fastify' {
  interface FastifyRequest {
    problemCode: string | null;
    errorType: string | null;
    stackFrames: string | null;
  }
}

const SAFE_ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'AggregateError']);
const SOURCE_FILE = /^[A-Za-z0-9_.-]{1,80}\.(?:[cm]?[jt]sx?)$/;

function safeErrorDiagnostic(error: unknown): { errorType: string; stackFrames: string[] } {
  if (!(error instanceof Error)) return { errorType: 'NonErrorThrow', stackFrames: [] };

  let errorType = 'Error';
  let messageLineCount = 1;
  let stack: unknown;
  try {
    if (SAFE_ERROR_TYPES.has(error.name)) errorType = error.name;
    if (typeof error.message === 'string') messageLineCount = error.message.split('\n').length;
    stack = error.stack;
  } catch {
    return { errorType, stackFrames: [] };
  }

  const stackFrames = (typeof stack === 'string' ? stack.slice(0, 16_384) : '').split('\n').slice(messageLineCount).flatMap((line) => {
    const match = line.match(/^\s*at .+? \((.+):(\d+):(\d+)\)$/) ?? line.match(/^\s*at (.+):(\d+):(\d+)$/);
    if (!match) return [];
    const fileName = match[1]!.split(/[\\/]/).at(-1)!;
    if (!SOURCE_FILE.test(fileName)) return [];
    return [`${fileName}:${match[2]}`];
  }).slice(0, 5);

  return { errorType, stackFrames };
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
  app.decorateRequest('errorType', null);
  app.decorateRequest('stackFrames', null);
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error.validation || error.statusCode === 400) return problem(reply, 400, 'invalid_input', 'The request input is invalid.');
    const diagnostic = safeErrorDiagnostic(error);
    reply.request.errorType = diagnostic.errorType;
    reply.request.stackFrames = diagnostic.stackFrames.join(' <- ');
    return problem(reply, 500, 'internal_error', 'An unexpected error occurred.');
  });
  app.setNotFoundHandler((_request, reply) => problem(reply, 404, 'not_found', 'The requested resource was not found.'));
}
