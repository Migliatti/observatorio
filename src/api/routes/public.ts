import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { SOURCES } from '../../domain/source.js';
import { EXOPLANET_ARCHIVE_ATTRIBUTION, metaSchema, sourceMeta } from '../source-meta.js';

const nullableTimestamp = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);
const statusSchema = Type.Object({
  data: Type.Object({ sources: Type.Array(Type.Object({
    name: Type.String(), last_run_status: Type.Union([Type.String(), Type.Null()]),
    last_run_finished_at: nullableTimestamp,
  })) }),
  meta: metaSchema,
});

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/status', {
    schema: { tags: ['Status'], summary: 'Check coleta status and freshness', response: { 200: statusSchema } },
  }, async () => app.db.transaction().setIsolationLevel('repeatable read').execute(async (db) => {
    const now = app.now();
    const sources = await Promise.all(SOURCES.map((source) => sourceMeta(db, source, now)));
    const runs = await Promise.all(SOURCES.map(async (source) => {
      const last = await db.selectFrom('ingestion_run').select(['status', 'finished_at']).where('source', '=', source)
        .orderBy('started_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
      return { name: source, last_run_status: last?.status ?? null, last_run_finished_at: last?.finished_at ?? null };
    }));
    return { data: { sources: runs }, meta: { sources } };
  }));

  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.get('/docs', { schema: { hide: true } }, async (_request, reply) => reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Observatório API</title></head>
<body><main><h1>Observatório API v1</h1>
<p>Dados astronômicos coletados e histórico em Postgres. <a href="/v1/openapi.json">Baixar a especificação OpenAPI</a>.</p>
<h2>Autenticação</h2><p>Envie <code>Authorization: Bearer obs_…</code> nas rotas de dados. Crie sua chave pelo CLI <code>npm run keys -- create kepler-lab</code>.</p>
<h2>Rotas</h2><ul>
<li><code>GET /v1/exoplanets</code>: catálogo com filtros e ordenação.</li>
<li><code>GET /v1/exoplanets/{name}</code>: detalhe pelo nome codificado na URL.</li>
<li><code>GET /v1/exoplanets/{name}/revisions</code>: histórico do mais recente para o mais antigo.</li>
<li><code>GET /v1/close-approaches</code>: aproximações por datas UTC e perigo potencial.</li>
<li><code>GET /v1/status</code>: resultado e frescor das coletas; público.</li>
</ul><p>Listas aceitam <code>limit</code> de 1 a 200 (padrão 50) e <code>cursor</code>. Preserve os filtros ao continuar com <code>meta.next_cursor</code>.</p>
<p>Respostas usam <code>{ data, meta }</code>. Ausências são <code>null</code>; erros usam <code>application/problem+json</code> e um <code>code</code> estável. Chave ausente, inválida ou revogada retorna <code>401 invalid_api_key</code>.</p>
<h2>Fontes e atribuição</h2><p>${EXOPLANET_ARCHIVE_ATTRIBUTION}</p><p>NASA/JPL Center for Near Earth Object Studies (CNEOS), Near Earth Object Web Service (NeoWs).</p>
</main></body></html>`));
}
