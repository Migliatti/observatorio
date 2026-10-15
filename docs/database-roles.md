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
produção. Essa capacidade precisa ser confirmada no deploy antes de aplicar a
migration. Não houve conexão nem tentativa de aplicar a migration em Neon.
