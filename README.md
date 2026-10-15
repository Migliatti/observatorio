# observatorio

Agregador de dados astronômicos: coleta fontes públicas (NASA e afins), guarda o histórico em Postgres e serve por uma API própria. Glossário em [CONTEXT.md](CONTEXT.md).

## Requisitos

- Node 24 e npm
- Docker (para o Postgres local)

## Rodando localmente

```sh
npm install
cp .env.example .env
npm run db:up        # sobe o Postgres 18 local (mesma major do Neon)
npm run db:migrate   # aplica as migrations e regera os tipos do banco
npm run dev          # API em http://localhost:3000 (GET /health)
```

A API valida as variáveis de ambiente no boot e não sobe com configuração inválida.

## Scripts

| Script | O que faz |
| --- | --- |
| `dev` / `start` | API em desenvolvimento (tsx) / compilada (`dist/`) |
| `build` | Compila para `dist/` |
| `lint` / `typecheck` / `test` / `test:fast` | Oxlint, `tsc --noEmit`, suite Vitest completa / testes sem Postgres |
| `db:up` / `db:down` | Sobe / derruba o Postgres do docker-compose |
| `db:migrate` | Migrations pelo `Migrator` do Kysely, usando `MIGRATOR_DATABASE_URL` direta (só para frente), e `db:codegen` em seguida |
| `db:codegen` / `db:codegen:check` | Regera / confere os tipos em `src/db/generated` usando `MIGRATOR_DATABASE_URL` |
| `collect` | Coleta: `npm run collect -- exoplanet-archive` ou `npm run collect -- neows` (conexão direta em `COLLECTOR_DATABASE_URL`) |
| `keys` | Gestão de chaves: `create <consumidor>`, `list` ou `revoke <id>` (conexão direta em `KEYS_DATABASE_URL`) |

Os processos usam URLs separadas: `API_DATABASE_URL` (endpoint pooled em produção),
`COLLECTOR_DATABASE_URL` e `MIGRATOR_DATABASE_URL` (endpoints diretos). O pool da
API aceita até 5 conexões, expira tentativas após 10 segundos e tenta conectar até
5 vezes com jitter. As permissões e o primeiro bootstrap estão em
[docs/database-roles.md](docs/database-roles.md).

## Consumindo a API

Depois de migrar o banco, crie uma chave com `npm run keys -- create kepler-lab`.
O CLI exibe a chave somente na criação; guarde-a para enviar
`Authorization: Bearer obs_…` nas rotas de dados. `npm run keys -- list` mostra
somente os metadados; `npm run keys -- revoke <id>` revoga uma chave.
A revogação passa a valer em até 60 segundos nas instâncias em execução.

`/health`, `/v1/status`, `/v1/openapi.json` e `/docs` são públicos.
O [contrato da API](docs/api.md) descreve filtros, histórico, paginação e erros.

## Testes

Os testes de integração usam o Postgres do docker-compose de verdade (sem mocks de banco), num banco separado (`TEST_DATABASE_URL`, padrão `observatorio_test`) que o Vitest cria e migra sozinho. Cada teste começa com as tabelas vazias.

O Vitest lê o `.env` (variáveis já definidas no ambiente têm prioridade). Como os testes truncam todas as tabelas, `TEST_DATABASE_URL` precisa apontar para um banco cujo nome termina em `_test` e para um host local (`localhost`, `127.0.0.1` ou `::1`). Para usar um host remoto de propósito, defina `ALLOW_REMOTE_TEST_DATABASE=1`.

## Estrutura

- `src/sources`: clientes HTTP das fontes e parsers puros
- `src/db`: Kysely, migrations e tipos gerados
- `src/collect`: CLI de coleta
- `src/api`: Fastify (rotas, configuração)
- `src/domain`: regras puras

`api` e `collect` não se importam (Oxlint `no-restricted-imports` e `src/architecture.test.ts`); `domain` e `sources` não tocam `db`.

## Migrations

Arquivos `src/db/migrations/NNNN_descricao.ts`, exportando só `up` com SQL puro. Não existe `down`: para desfazer, escreva uma nova migration.

## Coleta do NeoWs

Configure `NASA_API_KEY` e execute `npm run collect -- neows`. Cada coleta pede um feed único de hoje em UTC até +6 dias, com retry para falhas temporárias. Asteroides usam o id do JPL; aproximações usam o asteroide e a data UTC derivada do epoch da fonte. Previsões de hoje e futuras são reescritas; aproximações de dias passados ficam congeladas. As contagens vistas, criadas e revisadas da execução referem-se às aproximações. A API não precisa da chave da NASA.
