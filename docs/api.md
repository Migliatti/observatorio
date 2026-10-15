# Exoplanetas (`/v1`)

Todas as rotas de dados exigem `Authorization: Bearer obs_…`.
Crie a chave com `npm run keys -- create kepler-lab`; ela contém 32 bytes
aleatórios em base64url e aparece somente na criação. O banco guarda o SHA-256,
um prefixo de identificação, o consumidor e os instantes de criação, uso e
revogação. `npm run keys -- list` lista os metadados seguros e
`npm run keys -- revoke <id>` revoga uma chave. Para rotacionar, crie outra e
revogue a anterior.

Chave ausente, inválida ou revogada responde `401 invalid_api_key` no mesmo
formato `problem+json`. A validação tem cache por 60 segundos em cada instância;
uma chave recém-revogada pode continuar aceita até esse prazo. O instante
`last_used_at` é atualizado no máximo uma vez a cada cinco minutos por chave.

Cada chave tem um token bucket com capacidade padrão de 30 pedidos e reposição
de um token por segundo. Antes da autenticação, cada IP tem limite de 30 pedidos
por janela móvel de 60 segundos. `RateLimit-Limit`, `RateLimit-Remaining` e
`RateLimit-Reset` descrevem o limite aplicado; `RateLimit-Reset` e `Retry-After`
são segundos. Um pedido que responde `304` também consome um token da chave.
Capacidade, reposição, janela e origens CORS são configuráveis no ambiente.
Os contadores ficam em memória: reiniciar o processo ou iniciar uma instância
fria repõe os limites; instâncias distintas não compartilham contadores, então
o limite efetivo pode multiplicar-se pelo número de instâncias ativas.

As rotas de dados aceitam origens CORS exatas de `CORS_ORIGINS`, separadas por
vírgulas. O padrão inclui `https://kepler-lab-gamma.vercel.app` e os endereços
locais de desenvolvimento `http://localhost:5173` e `http://localhost:3000`.
Em produção, configure a origem publicada do consumidor; em desenvolvimento,
mantenha também as origens locais. `/health`, `/v1/status`, `/v1/openapi.json`
e `/docs` aceitam qualquer origem. A API expõe `ETag`, `Retry-After` e os
headers `RateLimit-*` ao navegador.

O servidor não confia em `X-Forwarded-For` por padrão. Se estiver atrás de um
proxy reverso, configure `TRUSTED_PROXIES` com os IPs ou CIDRs explícitos dos
proxies, separados por vírgulas. Inclua somente proxies que removem ou sobrescrevem
headers encaminhados recebidos do cliente; uma allowlist vazia mantém a confiança
desativada.

`/health`, `/v1/status`, `/v1/openapi.json` e `/docs` continuam acessíveis sem chave.
O status expõe o resultado e fim da última coleta de cada fonte em `data.sources`
e o frescor da última coleta bem-sucedida em `meta.sources`. O OpenAPI descreve
os schemas e a autenticação Bearer das rotas; `/docs` contém o guia público.

`GET /v1/exoplanets` retorna `{ data: [], meta: { sources: [], next_cursor, updates_available, snapshot_expires_at } }`.
Cada item contém apenas campos tipados em `snake_case`; valores ausentes são `null`.
`id` é uma string decimal para preservar a precisão de `bigint`.
`raw` e `content_hash` não são expostos.

| Parâmetro | Comportamento |
| --- | --- |
| `name` | Contém o texto informado, sem diferenciar maiúsculas; `%` e `_` são caracteres literais. |
| `host_name`, `discovery_method` | Correspondência exata. |
| `discovery_year_min`, `discovery_year_max` | Limites inclusivos do ano de descoberta. |
| `radius_earth_radii_min`, `radius_earth_radii_max` | Limites inclusivos do raio em raios terrestres. |
| `mass_earth_masses_min`, `mass_earth_masses_max` | Limites inclusivos da massa em massas terrestres. |
| `include_removed` | Booleano; padrão `false`. |
| `sort` | `name` (padrão), `discovery_year`, `radius_earth_radii` ou `mass_earth_masses`. |
| `order` | `asc` (padrão) ou `desc`; valores `null` ficam por último nos dois casos. |
| `limit` | Inteiro de 1 a 200; padrão 50. |
| `cursor` | Cursor opaco devolvido em `meta.next_cursor`; `null` indica o fim. |

Todas as ordenações usam `id` como desempate, na mesma direção.
Para continuar, preserve os filtros e a ordenação; é permitido mudar o `limit`.
A primeira página escolhe a versão atual do catálogo. O cursor mantém essa mesma
versão nas páginas seguintes, incluindo valores, filtros, removidos e ordenação,
mesmo quando outra coleta revisa, insere, remove ou faz um exoplaneta reaparecer.
Não decodifique nem modifique o cursor.

`meta.updates_available` sinaliza que uma nova coleta bem-sucedida publicou outro
catálogo desde o início dessa navegação. O aplicativo pode oferecer “Há dados
novos — atualizar”, sem descartar a lista em andamento. Ao escolher atualizar,
faça uma nova consulta sem cursor, preservando filtros e ordenação. Uma coleta
que falha não publica outro catálogo. O sinal é consultado a cada página; a API
não envia notificações automaticamente.

`meta.sources[].data_as_of` e `stale` descrevem a versão que está sendo lida,
não a versão mais recente. Isso mantém o frescor coerente com os itens exibidos.
A primeira página escolhe uma versão publicada completa, coordenada com a
coleta por um lock compartilhado durante a leitura. Ao continuar, a versão, os
dados e a disponibilidade de atualização são lidos na mesma transação
`REPEATABLE READ`. Nenhum lock permanece aberto entre pedidos HTTP.

A navegação vale por 48 horas desde a primeira página, sem estender o prazo a
cada pedido. `meta.snapshot_expires_at` informa esse limite. Depois dele, a API
responde `400 invalid_cursor`; reinicie sem cursor. Versões substituídas são
mantidas no banco por 48 horas após a substituição e limpas na próxima coleta
bem-sucedida. O catálogo atual permanece disponível mesmo se a fonte ficar
sem responder por vários dias. As revisões permanentes dos exoplanetas não
são apagadas. Antes da primeira coleta, uma lista vazia pode devolver
`snapshot_expires_at: null`.

`GET /v1/exoplanets/{name}` usa o nome do Archive codificado na URL, por exemplo
`/v1/exoplanets/HD%202039%20b`. O envelope é `{ data: {}, meta: { sources: [] } }`.
Planetas removidos respondem `404 not_found` por padrão; `?include_removed=true`
os inclui com `removed_at` preenchido. O detalhe consulta sempre os dados atuais;
a versão fixada pelo cursor se aplica à lista.

`meta.sources[]` contém `name`, `data_as_of`, `stale` e `attribution`. O frescor
é o instante da última coleta bem-sucedida. Uma falha posterior não o substitui.
O dado continua sendo servido quando passam mais de 48 horas; exatamente 48 horas
ainda é fresco. Sem coleta bem-sucedida, `data_as_of` é `null` e `stale` é `true`.
A API lê somente o Postgres; nenhuma requisição consulta a NASA.

O crédito do Archive inclui a frase de agradecimento oficial e a referência
Christiansen et al. (2025), que substitui Akeson et al. (2013), conforme
[a orientação do Archive](https://exoplanetarchive.ipac.caltech.edu/docs/acknowledge.html).

## Revisões

`GET /v1/exoplanets/{name}/revisions` retorna as revisões permanentes, da mais
nova para a mais antiga, com `id`, `parameters` (campos tipados), `recorded_at`
e `changed_fields[]`. A coleta guarda os parâmetros anteriores quando detecta
uma alteração. Cada revisão é comparada com a revisão cronologicamente anterior;
a mais antiga tem `changed_fields: []`, porque não existe uma revisão anterior.
O estado atual permanece na rota de detalhe.

O envelope é `{ data: [], meta: { sources: [], next_cursor } }`.
`limit` aceita 1 a 200 e tem padrão 50. Continue com `cursor` mantendo o nome e
`include_removed` (padrão `false`); é permitido mudar `limit`. A lista fica
limitada às revisões existentes no início da navegação, e usa `id` para desempatar
instantes iguais. Sem histórico, a lista é vazia; nome inexistente ou removido
responde `404 not_found`, salvo `include_removed=true` para removidos.
Os cursores de revisões expiram em 48 horas ou após reinício do processo;
`400 invalid_cursor` pede reinício da paginação.

## Aproximações

`GET /v1/close-approaches` lista aproximações em ordem de data ascendente,
com `id` interno como desempate. Cada item contém `date` (`YYYY-MM-DD` em UTC),
`miss_distance_km`, `relative_velocity_kms`, `orbiting_body` e `asteroid`.
O asteroide traz `id` (código JPL), `name`, `absolute_magnitude_h`,
`estimated_diameter_min_km`, `estimated_diameter_max_km` e
`is_potentially_hazardous`. Valores ausentes são `null`; o `raw` não é exposto.

`from` e `to` aceitam datas UTC inclusivas. Quando omitidos, valem hoje e hoje
+6 dias, respectivamente. Datas inválidas, ordem invertida ou janela com mais
de 366 dias inclusivos respondem `400 invalid_input`. `hazardous=true` filtra
os potencialmente perigosos; `false` ou ausência inclui ambos.

`limit` aceita 1 a 200 (padrão 50); `cursor` continua a lista com os mesmos
filtros. O envelope inclui `meta.next_cursor`, `meta.sources[]` com o crédito
NASA/JPL CNEOS NeoWs e `meta.coverage: { from, to }`. A cobertura informa o
intervalo disponível independentemente da janela pedida e do filtro de perigo;
uma consulta fora dele retorna uma lista vazia.
As coletas novas registram a janela solicitada inclusive quando a fonte retorna
zero aproximações; uma falha não amplia a cobertura. Para dados anteriores à
migration de cobertura, as datas dos eventos preservados servem como referência.
Sem qualquer janela ou evento conhecido, ambos os limites são `null`.

## Erros

Erros usam `application/problem+json` com `type`, `title`, `status`, `code` e
`detail`. Códigos: `invalid_input` (400), `invalid_cursor` (400), `invalid_api_key` (401), `not_found` (404)
e `internal_error` (500). Trate o `code`, pois o texto não é um contrato estável.
