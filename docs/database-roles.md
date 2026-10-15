# Papéis e conexões do Postgres

Cada processo recebe uma URL própria. Nunca configure a API ou o coletor com a URL
administrativa usada para o primeiro deploy.

| Variável | Uso | Endpoint | Permissões |
| --- | --- | --- | --- |
| `API_DATABASE_URL` | API | pooled em produção | role `observatorio_api`: `SELECT` nas tabelas de dados e chaves; `UPDATE` somente em `api_key.last_used_at` |
| `COLLECTOR_DATABASE_URL` | coletor | direto | role `observatorio_collector`: leitura e escrita nas tabelas de dados e execuções; sem acesso de escrita a `api_key` e sem DDL |
| `MIGRATOR_DATABASE_URL` | deploy de migrations | direto | role `observatorio_migrator`, proprietária dos objetos da aplicação e usada no deploy |
| `KEYS_DATABASE_URL` | CLI `keys` | direto | role `observatorio_key_admin`, limitada à leitura, criação e revogação de chaves |

A API limita o pool a 5 conexões, usa timeout de conexão de 10 segundos e faz até
5 tentativas de conexão com backoff exponencial e jitter. O coletor usa conexão
direta porque mantém um advisory lock por sessão. Migrations também usam conexão
direta.

## Primeiro bootstrap

A migration `0009_least_privilege_roles` cria as roles `observatorio_migrator`,
`observatorio_collector`, `observatorio_api` e `observatorio_key_admin`, transfere
a propriedade das tabelas da aplicação para `observatorio_migrator` e aplica os
grants mínimos. O prefixo `observatorio_` evita alterar papéis homônimos de outros
aplicativos no mesmo cluster. Na primeira execução, `MIGRATOR_DATABASE_URL`
precisa apontar para uma conexão owner com permissão de criar roles. Depois da
migration, defina senhas para as roles de serviço com o comando interativo `\password`
no `psql` e configure as URLs de API, coleta, migrations e gestão de chaves com
seus respectivos nomes de role `observatorio_*`. A URL pooled deve ser usada somente pela API.
O deploy também concede ao usuário que aplicou a migration membership em
`observatorio_migrator` com `SET TRUE` e `INHERIT TRUE`: `SET` permite transferir propriedade
dos objetos e `INHERIT` disponibiliza as permissões herdadas ao processo de deploy.
Antes de alterar qualquer role, a 0009 verifica `CREATEROLE` e, para cada role
`observatorio_*` que já exista, exige `ADMIN OPTION`; se alguma role alvo for `SUPERUSER`, exige uma
conexão superuser. Se o preflight falhar, nenhuma alteração de role foi iniciada.

## Atualização de bancos com a 0009 antiga

Para um banco que já registrou a versão anterior da migration `0009`, a migration `0010` cria
as roles `observatorio_*`, transfere a propriedade das tabelas e sequências do aplicativo e
reaplica os grants mínimos. Execute essa atualização uma vez com `MIGRATOR_DATABASE_URL`
apontando para a mesma conexão direta owner usada no bootstrap, com permissão `CREATEROLE`.
A migration falha antes de alterar roles se a conexão efetiva não tiver `CREATEROLE` (ou for
superuser). Se qualquer role `observatorio_*` já existir, o usuário também precisa de `ADMIN OPTION`
sobre cada role existente; o preflight valida essa condição antes de executar DDL. Em PostgreSQL 16,
`CREATEROLE` sozinho não permite administrar roles preexistentes sem essa opção. Use o usuário
bootstrap que criou as roles, um superuser, ou peça a um administrador para conceder as opções antes
da atualização. O preflight também interrompe a migration se alguma role alvo preexistente tiver
`SUPERUSER`; nesse caso, somente uma conexão superuser pode administrá-la com segurança. A role
`migrator` legada da 0009 é `NOCREATEROLE`, então não pode provisionar as novas roles. Depois que
`npm run db:migrate`
terminar, configure `MIGRATOR_DATABASE_URL`, `API_DATABASE_URL`, `COLLECTOR_DATABASE_URL` e
`KEYS_DATABASE_URL` com as respectivas roles `observatorio_*`; API continua usando endpoint pooled.
Se a role genérica legada `migrator` ainda existir, o preflight também exige que a conexão de deploy
herde as permissões dela (`pg_has_role(..., 'migrator', 'USAGE')`), pois ela pode ser proprietária
dos objetos que a 0010 transfere. A migration define explicitamente `SET TRUE` e `INHERIT TRUE` na
membership do usuário de deploy com `observatorio_migrator`.

A migration `0010` não cria, altera ou remove as definições das roles genéricas legadas, nem
revoga grants atribuídos a elas. A propriedade das tabelas deste aplicativo que estava com a role
`migrator` é transferida para `observatorio_migrator`; as demais roles legadas e seus grants
permanecem como estão. Só remova roles ou grants legados depois de confirmar que nenhum outro
aplicativo compartilha essas roles.

O `KEYS_DATABASE_URL` usa a role operacional `observatorio_key_admin` para preservar os comandos
de criar, listar e revogar chaves sem ampliar os privilégios da API ou do coletor.
Ela não executa migrations nem possui acesso às tabelas de dados.

Migrations futuras devem conceder explicitamente à role `observatorio_collector` os privilégios
de DML e de sequência necessários para cada nova tabela de coleta. A role `observatorio_api`
recebe `SELECT` automaticamente em tabelas futuras criadas por `observatorio_migrator`; os
grants de escrita permanecem explícitos.

## Verificação externa pendente

O código e as verificações locais não determinam se a criação SQL dessas roles e a
transferência de propriedade são permitidas no projeto/plano Neon Free usado em
produção. Essa capacidade precisa ser confirmada no deploy antes de aplicar as
migrations. Não houve conexão nem tentativa de aplicar migration em Neon.
