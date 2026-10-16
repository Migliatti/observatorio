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

  app.get('/v1/openapi.json', {
    schema: { tags: ['Documentation'], summary: 'Get the generated OpenAPI 3.1 document' },
  }, async () => app.swagger());
  app.get('/docs', { schema: { hide: true } }, async (_request, reply) => reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Observatório API</title></head>
<body><main><h1>Observatório API v1</h1>
<p>Dados astronômicos e histórico servidos pela API do Observatório. <a href="/v1/openapi.json">Consultar o documento OpenAPI 3.1 gerado dos schemas das rotas</a>.</p>
<h2>Acesso</h2><p><code>/health</code>, <code>/v1/status</code>, <code>/v1/openapi.json</code> e esta página são públicos. Nas rotas de dados, envie <code>Authorization: Bearer obs_…</code>. Crie sua chave pelo CLI <code>npm run keys -- create kepler-lab</code>.</p>
<h2>Rotas</h2><ul>
<li><code>GET /v1/exoplanets</code>: catálogo com filtros e ordenação.</li>
<li><code>GET /v1/exoplanets/{name}</code>: detalhe pelo nome codificado na URL.</li>
<li><code>GET /v1/exoplanets/{name}/revisions</code>: histórico do mais recente para o mais antigo.</li>
<li><code>GET /v1/close-approaches</code>: aproximações por datas UTC e perigo potencial.</li>
<li><code>GET /v1/status</code>: resultado e frescor das coletas; público.</li>
<li><code>GET /v1/openapi.json</code>: contrato OpenAPI gerado a partir dos schemas TypeBox registrados.</li>
</ul><p>Listas aceitam <code>limit</code> de 1 a 200 (padrão 50) e <code>cursor</code>. Preserve os filtros ao continuar com <code>meta.next_cursor</code>.</p>
<p>Respostas de dados usam <code>{ data, meta }</code>. Ausências são <code>null</code>. <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> e <code>RateLimit-Reset</code> descrevem o limite aplicado; <code>Retry-After</code> informa a espera após <code>429</code>. As rotas de dados enviam <code>ETag</code> e <code>Cache-Control: private, no-cache</code>; reenvie o ETag em <code>If-None-Match</code> para receber <code>304</code> quando a representação não mudar.</p>
<p>Erros usam <code>application/problem+json</code>. Trate o campo estável <code>code</code>: <code>invalid_input</code>, <code>invalid_cursor</code>, <code>invalid_api_key</code>, <code>not_found</code>, <code>rate_limited</code> e <code>internal_error</code>. Chave ausente, inválida ou revogada retorna <code>401 invalid_api_key</code>.</p>
<h2>Fontes e atribuição</h2><p>${EXOPLANET_ARCHIVE_ATTRIBUTION}</p><p>NASA/JPL Center for Near Earth Object Studies (CNEOS), Near Earth Object Web Service (NeoWs).</p>
</main></body></html>`));
}
