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
migration, defina senhas independentes para as roles de serviço e configure as URLs
de API, coleta, migrations e gestão de chaves com
seus respectivos nomes de role `observatorio_*`. A URL pooled deve ser usada somente pela API.
O deploy também concede ao usuário que aplicou a migration membership em
`observatorio_migrator` com `SET TRUE` e `INHERIT TRUE`: `SET` permite transferir propriedade
dos objetos e `INHERIT` disponibiliza as permissões herdadas ao processo de deploy.
Antes de alterar qualquer role, a 0009 verifica `CREATEROLE` e, para cada role
`observatorio_*` que já exista, exige `ADMIN OPTION`; se alguma role alvo for `SUPERUSER`, exige uma
conexão superuser. Se o preflight falhar, nenhuma alteração de role foi iniciada.

Para conexões de bootstrap sem `SUPERUSER` (como o owner do Neon), as migrations
não incluem `NOSUPERUSER` nem `NOBYPASSRLS` no `ALTER ROLE`: mencionar esses atributos
exige privilégios adicionais mesmo quando já estão desativados. O preflight rejeita
roles existentes com `SUPERUSER`, `BYPASSRLS` ou `REPLICATION` antes de alterar qualquer
role; um administrador precisa corrigir esses atributos primeiro. As roles novas
continuam sendo criadas com privilégios mínimos.

`CREATEDB` não é exigido do bootstrap quando os papéis de serviço já têm `NOCREATEDB`:
nesse caso, o `ALTER ROLE` omite o atributo. Se algum papel existente tiver `CREATEDB`,
o preflight exige que o bootstrap também possua esse privilégio para removê-lo;
caso contrário, falha antes de alterar qualquer papel e orienta a correção por um
administrador. O caminho superuser continua removendo os atributos elevados.

## Senhas e destino dos segredos

No bootstrap validado no Neon, o painel recusou redefinir senhas de roles ainda sem
senha e o `psql \password` falhou com `Neon only supports being given plaintext passwords`.
Nesse ambiente, use `ALTER ROLE ... PASSWORD` por uma conexão owner direta com TLS.
Receba a senha por um prompt oculto (por exemplo, `Read-Host -AsSecureString`) e
construa o literal SQL com `pg.escapeLiteral`, nunca por concatenação de entrada sem
escape. Não coloque senhas no histórico, em SQL salvo, em logs ou em arquivos versionados;
remova variáveis temporárias em um bloco `finally`.

Depois de definir cada senha, teste uma nova conexão com aquele papel e execute
`SELECT current_user` antes de substituir as credenciais de bootstrap:

| Segredo | Destino | Papel / conexão |
| --- | --- | --- |
| `MIGRATOR_DATABASE_URL` | GitHub Actions | `observatorio_migrator`, direta; substitui a URL temporária de owner |
| `COLLECTOR_DATABASE_URL` | GitHub Actions | `observatorio_collector`, direta |
| `API_DATABASE_URL` | Environment do serviço Render | `observatorio_api`, pooled |
| `KEYS_DATABASE_URL` | `.env` local, ignorado pelo Git | `observatorio_key_admin`, direta |

Em outra máquina, configure apenas os segredos locais necessários. Papéis, senhas e
migrations já aplicadas ficam no Neon; secrets do Actions e variáveis do Render ficam
nos respectivos serviços. Senhas com caracteres reservados precisam de codificação
percentual ao montar URLs; prefira o gerador de conexão do Neon.

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

## Validação externa

No bootstrap de produção do Observatório, as migrations `0001` a `0010` foram
aplicadas no Neon e o codegen identificou oito tabelas. Os quatro papéis tiveram
seus logins testados com `SELECT current_user`; a API foi testada pelo endpoint pooled.
Isso confirma o bootstrap e os logins nesse ambiente, mas não substitui testes de
privilégios nem a validação da coleta e do deploy reais. Os testes locais de privilégios
continuam necessários. Não registre senhas nem URLs de conexão como evidência.
