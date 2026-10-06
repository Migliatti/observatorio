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
| `lint` / `typecheck` / `test` | Oxlint, `tsc --noEmit`, Vitest |
| `db:up` / `db:down` | Sobe / derruba o Postgres do docker-compose |
| `db:migrate` | Migrations pelo `Migrator` do Kysely (só para frente) e `db:codegen` em seguida |
| `db:codegen` / `db:codegen:check` | Regera / confere os tipos em `src/db/generated` |
| `collect` | CLI de coleta (ainda um esboço) |

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
