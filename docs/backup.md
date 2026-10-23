# Backup do histórico e restauração (#30)

## Contrato e ativação

`.github/workflows/backup.yml` agenda domingo às 04:23 UTC (01:23 em São Paulo)
e oferece `workflow_dispatch`, somente em `main`. Retenção: **21 dias** por artefato;
o nome inclui execução e tentativa. Permissão do token: `contents: read`, sem
credencial Git persistida. Não há trigger de PR, push, deploy ou alteração de secrets.
A execução falha se a credencial estiver ausente ou for privilegiada demais.

Preparação local; **não foi ativado nem executado no GitHub e não acessou produção**.
O responsável por #28 deve provisionar, em etapa separadamente autorizada,
`BACKUP_DATABASE_URL` como secret Actions: conexão **direta com TLS** e login
exclusivo `observatorio_backup` com apenas CONNECT, USAGE e SELECT nos sete objetos
abaixo. Não reutilizar `MIGRATOR_DATABASE_URL`, owner, API ou coletor. O job nunca
recebe `KEYS_DATABASE_URL`, senha de migrator, chave NASA ou hook de deploy.

As migrations 0009/0010 confirmam que `observatorio_collector` consegue ler as sete
tabelas e sequências **sem acesso a `api_key`**, mas também tem INSERT/UPDATE/DELETE.
`observatorio_api` lê chaves; `observatorio_key_admin` administra chaves;
`observatorio_migrator` é proprietária. **Não existe papel somente leitura sem
chaves entre esses quatro**. O script rejeita esses papéis por suas permissões.
É necessária credencial exclusiva; nenhuma migration ou role existente foi alterada
nesta entrega. O modelo abaixo é uma proposta para provisionamento pelo administrador,
não um comando executado em produção; alinhar com Codex/#28 antes de aplicá-lo:

```sql
CREATE ROLE observatorio_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS NOREPLICATION;
-- Conceder CONNECT no banco exato; atribuir senha por canal seguro, fora de arquivos/logs.
GRANT CONNECT ON DATABASE <banco_exato> TO observatorio_backup;
GRANT USAGE ON SCHEMA public TO observatorio_backup;
GRANT SELECT ON TABLE public.ingestion_run, public.exoplanet,
  public.exoplanet_revision, public.exoplanet_catalogue,
  public.exoplanet_catalogue_item, public.asteroid, public.close_approach
TO observatorio_backup;
```

Não conceder memberships, CREATE, DML, acesso a chaves ou privilégios automáticos
para tabelas futuras. A criação de banco temporário usa outra conexão, **somente
local ao runner**, nunca a credencial da origem. Não é necessário SELECT nas
sequências da origem: seus próximos valores são reconstruídos por `max(id)`.
O preflight verifica privilégios efetivos, escrita, CREATE e acesso a qualquer
coluna de `api_key`; não basta confiar no nome do usuário. A ausência de memberships
é também uma regra de provisionamento a ser verificada pelo administrador.

## O que cobre

Snapshot consistente `REPEATABLE READ READ ONLY` das tabelas:

| Tabela | Conteúdo preservado |
| --- | --- |
| `ingestion_run` | Datas, status, fonte, contagens e cobertura |
| `exoplanet` | Estado tipado, hash, primeira/última observação e remoção |
| `exoplanet_revision` | Parâmetros históricos científicos, hash e data |
| `exoplanet_catalogue` | Identidade, vínculo com coleta, datas e expiração |
| `exoplanet_catalogue_item` | Itens e parâmetros dos snapshots de paginação |
| `asteroid` | Identidade, parâmetros, primeira/última observação |
| `close_approach` | Aproximações históricas, datas, distâncias e velocidades |

São preservados IDs e FKs. As sequências da cópia são ajustadas para `max(id)`
ou 1 para tabela vazia: lacunas/valores consumidos sem linha na origem não são
reproduzidos. Datas e microssegundos são copiados como texto para evitar perda
pelo parser de datas do JavaScript. A memória da cópia é limitada a 500 linhas
por lote; a cópia insere lotes parametrizados.

## O que não cobre e por quê

- **Toda `api_key`**, inclusive hashes, consumidores, prefixos, revogações,
  último uso, estrutura e sequência. Nem é consultada pela cópia; só seus
  privilégios são verificados em catálogo do Postgres.
- `ingestion_run.error`: erros podem conter URLs, tokens e diagnósticos privados.
- `raw` de planetas, asteroides e aproximações: JSON bruto pode carregar URLs
  com `api_key` upstream. Restaurado como `{}`; dados brutos precisarão ser
  recoletados, e a representação bruta antiga não será recuperável.
- Chaves de cursor: a cópia usa string vazia e a restauração gera chaves novas;
  cursores anteriores deixam de valer.
- Campos inesperados em `exoplanet_revision.parameters`: são copiados somente
  parâmetros científicos conhecidos, sem JSON bruto ou metadados extras.
- Roles, senhas, grants, configurações de serviços, `.env`, secrets e histórico
  `kysely_migration`. Não há `pg_dumpall`, dump de globais ou upload de logs.

O artefato contém dados astronômicos públicos tipados, schema desses objetos,
sequências, contagens, horário da cópia e checksum. **Não é um backup integral**.
Novas tabelas/colunas não entram automaticamente: revisar `tables.ts`, o schema
congelado das migrations 0001–0008 e o ensaio antes de ampliar o contrato.
Campos científicos textuais devem continuar recebendo apenas dados públicos das
fontes; nenhuma ferramenta consegue identificar um segredo arbitrário inserido
manualmente no nome de um planeta. As superfícies conhecidas de credenciais são
omitidas estruturalmente, sem depender de regex de redação.

## Como é produzido

`node --import tsx scripts/backup/create.ts historical.dump` recebe
`BACKUP_DATABASE_URL` e `BACKUP_STAGING_DATABASE_URL` pelo ambiente. Não passe
URLs como argumentos nem use `set -x`. A segunda URL deve apontar a um Postgres
local **exclusivo e descartável**, com permissão para criar banco; não é conexão
owner de produção. O script aceita apenas loopback para staging e cria nome
aleatório próprio, removido em `finally`, inclusive em falha.

A origem é lida uma vez num snapshot sem escrita. A cópia local recebe apenas as
colunas aprovadas; `pg_dump --format=custom` roda **nessa cópia sanitizada**, com
lista explícita de tabelas/sequências e exclusão adicional de `public.api_key`,
sem owner, ACLs, comentários, security labels ou large objects. Artefatos só são
publicados após sucesso; erros de ferramentas/conexão não são enviados ao log.
O job faz upload apenas de `historical.dump`, `.sha256` e `.json`, sem diretórios
inteiros e sem `always()` após falha.

Cliente e staging usam **PostgreSQL major 18**. O wrapper do workflow usa a imagem
`postgres:18-alpine` para não depender da versão instalada no runner; o script
recusa cliente de outra major. A imagem acompanha patches da major 18. A cópia
lê pela biblioteca `pg`, sem exigir que um pg_dump antigo se conecte ao Neon 18.

## Restauração verificável, somente em ambiente próprio

1. Crie um **cluster local exclusivo e descartável PostgreSQL 18**, em porta livre,
   e um banco vazio com prefixo `observatorio_restore_`. Não use o banco de testes
   compartilhado nem um cluster com roles de outro aplicativo. Roles são globais
   ao cluster; o bootstrap das migrations só é apropriado no cluster próprio.
2. Faça checkout do commit que produziu o backup. Instale as dependências
   (`npm ci`) e coloque `pg_restore` 18 no PATH. Baixe os três arquivos do mesmo
   artefato em diretório privado, preservando seus nomes. Verifique a procedência:
   checksum detecta corrupção, mas não autentica um arquivo malicioso.
3. Configure `RESTORE_DATABASE_URL` pelo ambiente para o banco local vazio.
   O bootstrap local requer administrador do **cluster descartável**, pois executa
   as migrations de roles; nunca use essa URL como credencial de backup da origem.
4. Execute:

   ```sh
   node --import tsx scripts/backup/restore.ts /caminho/privado/historical.dump
   ```

   O script confere checksum e destino vazio/loopback, executa migrations locais,
   remove somente o catálogo vazio semeado pelo bootstrap, restaura os dados na ordem das dependências, em
   transação única e gera chaves de cursor novas. `api_key` é criada vazia pelas
   migrations locais; o dump não a contém. Não desativa constraints nem usa
   `--clean` ou sobrescreve tabelas existentes. Em falha após bootstrap, use outro
   banco vazio próprio para repetir; não tente misturar cópias.
5. Compare as sete contagens com `.json`; inspecione revisões antigas, planetas
   removidos, aproximações e vínculos de catálogo. Confirme `count(*) = 0` em
   `api_key`, `error IS NULL`, `raw = '{}'`, FKs válidas e próximas identidades
   acima de `max(id)`. O ensaio automatizado faz essas verificações.
6. Para recriar chaves, use a CLI com `KEYS_DATABASE_URL` do papel
   `observatorio_key_admin` no ambiente recuperado e `npm run keys -- create
   '<consumidor>'`. A CLI exibe o token uma única vez: entregue-o por canal
   privado e atualize cada consumidor. Nunca publique a saída nem registre o token
   como evidência; chaves antigas não são recuperáveis. Roles/senhas do destino
   devem ser provisionadas separadamente, sem recuperar credenciais do artefato.
7. Encerre o cluster temporário próprio. Esta rotina **não promove dados para
   produção**; qualquer recuperação operacional exige validação do responsável,
   credenciais novas, configuração dos serviços e autorização própria.

Não chamar `npm run db:migrate` no checkout para esse ensaio: o script padrão
também executa codegen e pode alterar arquivos. A restauração chama diretamente
o migrator em memória, sem modificar arquivos gerados.

## Repetir o ensaio automatizado

Para criar automaticamente cluster próprio em diretório temporário e porta livre,
executar o ensaio e desligá-lo mesmo em falha, com os binários 18 no PATH:

```sh
bash scripts/backup/rehearse-local.sh
```

O harness usa autenticação trust **apenas no cluster local sintético**, diretório
privado e bind em loopback; não recebe URLs de origem/produção nem carrega `.env`.
Não o use em máquina com usuários locais não confiáveis.

Alternativamente, com cluster exclusivo criado por você, banco administrativo local vazio e cliente
18 no PATH, defina `BACKUP_STAGING_DATABASE_URL` e
`BACKUP_REHEARSAL_OWN_CLUSTER=yes`, então:

```sh
node --import tsx scripts/backup/rehearsal.ts
```

O ensaio cria `observatorio_backup_source` e `observatorio_restore_rehearsal`
sem `IF NOT EXISTS` (nunca reutiliza banco existente), aplica migrations reais,
popula sete tabelas, chave sintética e sentinelas nos campos omitidos. Confirma
permissões da credencial dedicada, rejeita owner/API/collector/migrator, testa
checksum inválido e destinos remoto/não vazio, executa dump e restore reais,
compara histórico e recria uma chave sem imprimir seu token. Arquivos sintéticos
ficam em `/tmp/observatorio-rehearsal-*` para inspeção; encerre o cluster que você
criou ao concluir. Não apontar o ensaio a um cluster de terceiros, nem local.

## Dependências e limites da entrega

A issue #30 e a #28 foram consultadas via `gh issue view --json ...` com comentários;
ambas não tinham comentários na consulta. Base: `5b2b1fc`, PR #45 integrada.
A #13 pode continuar desatualizada; este trabalho não confirma configuração de
secrets, privilégios ou disponibilidade de produção. Comunicação `maestri list`
falhou com `Operation not permitted`; não foi repetida ou escalada. Portanto o
alinhamento com Forja permanece para Codex: nome do secret novo, login somente
leitura separado, conexão direta TLS e nenhuma alteração de deploy/CI geral.

Ativação futura requer: provisionar login/secret de backup pelo responsável,
confirmar que as colunas aprovadas são públicas, integrar/revisar o workflow e
validar a primeira execução autorizada no Actions. Os 21 dias não constituem
arquivo permanente nem garantem uma execução semanal bem-sucedida: acompanhar
falhas e validade dos backups. Nenhuma dessas operações remotas foi realizada.

Referências: [pg_dump 18](https://www.postgresql.org/docs/18/app-pgdump.html)
e [retenção de artefatos no GitHub Actions](https://docs.github.com/en/actions/tutorials/store-and-share-data#configuring-a-custom-artifact-retention-period).

## Evidência local — 22/10/2026

Ensaio final: `PATH=/tmp/observatorio-30-pg18/bin:$PATH bash scripts/backup/rehearse-local.sh`,
exit **0**. Binários 18.0 compilados em `/tmp` a partir da distribuição oficial
porque só havia PostgreSQL 16.15 instalado e não havia daemon Docker disponível.
Servidor e `pg_dump`/`pg_restore` efetivamente executados: **18.0**. Cluster próprio
`observatorio-30-cluster.IuqFRZ`, porta livre **65157**, bind `127.0.0.1`.
O log confirmou `database system is shut down` após o trap de saída.

Resultado observado:

```text
PASS owner/API/collector/migrator and malformed credentials rejected without leaking diagnostics
PASS dedicated reader cannot read keys or write historical data
PASS decompressed archive excludes key table, hash, raw JSON, errors and cursor secret
PASS all seven table counts, previous revision, removed planet, approaches, microseconds, dates and identity sequences restored
PASS remote/nonempty destinations and invalid checksum rejected
PASS key recreation CLI (plaintext captured privately, never logged)
PASS staging databases cleaned after backup
Evidence: PostgreSQL 18.0; synthetic counts: 1 per table; no production access
```

A origem tinha uma linha em cada uma das sete tabelas, uma revisão com raio antigo
1 e estado atual 2, planeta removido, aproximação histórica e uma chave sintética.
O destino restaurou as sete contagens e passou de **zero chaves** para uma chave
nova somente após o teste explícito da CLI. A sentinela em erros, JSON bruto,
campos extras da revisão e cursor e o hash da chave não apareceram no dump
**descomprimido**. O teste também confirmou próxima identidade de aproximação 502,
data `2026-01-02` e timestamp com microssegundos `2026-01-01 00:00:00.123456`.

Verificações focadas adicionais, exit **0**:

```sh
node_modules/.bin/oxlint --deny-warnings scripts/backup
node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --target es2024 --module nodenext --skipLibCheck scripts/backup/*.ts
bash -n scripts/backup/rehearse-local.sh
```

O YAML foi carregado com `js-yaml`, a retenção de 21 dias foi conferida e todos os
blocos `run` passaram por `bash -n`. O adaptador Docker do workflow não foi executado
localmente pela ausência de daemon; sua validação no Actions continua pendente de
integração, credencial dedicada e autorização para uma primeira execução real.
Não foram executadas suites que usam banco compartilhado nem modificado CI geral.
