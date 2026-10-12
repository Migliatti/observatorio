# Exoplanetas (`/v1`)

`GET /v1/exoplanets` retorna `{ data: [], meta: { sources: [], next_cursor } }`.
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
O cursor guarda a posição sem depender de a linha anterior continuar visível e
fixa o maior `id` da primeira página, para que inserções posteriores não estendam a lista.
Quando uma nova coleta bem-sucedida termina, mesmo sem alterações de parâmetros,
o cursor é invalidado com
`400 invalid_cursor`: reinicie a navegação sem cursor. Assim, a API não mistura
páginas de estados diferentes da fonte, evitando saltos e repetições decorrentes
de parâmetros de ordenação revisados. A leitura do frescor e da página usa a
mesma transação com isolamento `REPEATABLE READ`.

`GET /v1/exoplanets/{name}` usa o nome do Archive codificado na URL, por exemplo
`/v1/exoplanets/HD%202039%20b`. O envelope é `{ data: {}, meta: { sources: [] } }`.
Planetas removidos respondem `404 not_found` por padrão; `?include_removed=true`
os inclui com `removed_at` preenchido.

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
