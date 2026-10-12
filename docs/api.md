# Exoplanetas (`/v1`)

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

Erros usam `application/problem+json` com `type`, `title`, `status`, `code` e
`detail`. Códigos: `invalid_input` (400), `invalid_cursor` (400), `not_found` (404)
e `internal_error` (500). Trate o `code`, pois o texto não é um contrato estável.
