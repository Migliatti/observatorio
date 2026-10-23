# Verificação agendada de saúde e frescor (#29)

`.github/workflows/health.yml` executa `scripts/verify-health.mjs` a cada seis
horas (`17 */6 * * *`, UTC: 00:17, 06:17, 12:17 e 18:17) e por
`workflow_dispatch`. O agendamento do Actions depende do arquivo na branch padrão
e pode sofrer atrasos. Não é um probe contínuo de uptime: evita manter o Render
grátis acordado. O job tem limite de seis minutos, sem instalar dependências npm.

Configuração externa necessária após o deploy da #28:

| Configuração do repositório | Uso |
| --- | --- |
| Actions variable `API_BASE_URL` | Origem HTTPS da API publicada, sem caminho, query ou credenciais. |
| Actions secret `HEALTHCHECKS_VERIFY_URL` | URL completa do ping de sucesso do check de **verificação**, distinto do check de coleta. |

As rotas públicas não precisam de chave de API: o script não envia Authorization
nem X-API-Key. Não configurar uma chave para esse job. URLs com credenciais
embutidas e redirects são rejeitados. HTTP é permitido apenas em loopback para
testes locais. Configuração ausente ou inválida falha antes de iniciar os probes.
O script não imprime URLs, corpos de resposta nem detalhes de erros de rede que
possam revelar o token do Healthchecks.

O script faz, em sequência:

1. `GET /health`: HTTP 200, JSON com `status: "ok"`. Essa rota é liveness e
   não consulta o banco.
2. `GET /v1/status`: HTTP 200, JSON no contrato atual de
   `src/api/routes/public.ts` e `src/api/source-meta.ts`.
3. Apenas após a validação, `GET HEALTHCHECKS_VERIFY_URL`: HTTP 200 confirma o
   sinal de sucesso. Falha nesse pedido também encerra com código 1.

Cada rota da API tem timeout de **120 segundos**, inclusive a leitura do corpo,
para tolerar cold start de aproximadamente um minuto. O ping tem 15 segundos.
Não há retries que escondam uma indisponibilidade. HTTP diferente de 200, JSON
inválido, content type incorreto, erro de rede ou timeout falham o job. Não é
enviado ping de falha nem ping de início: na falha o sinal de sucesso para.

O contrato de status contém duas listas, ambas exigindo exatamente uma entrada
para cada fonte v1 (`exoplanet-archive` e `neows`), sem duplicatas:

- `data.sources`: `name`, `last_run_status` (string ou null) e
  `last_run_finished_at` (timestamp ou null) descrevem a última execução.
- `meta.sources`: `name`, `data_as_of` (timestamp do último sucesso), `stale`
  (booleano) e `attribution` (string) descrevem o frescor.

Fonte ausente, metadados incompletos, `data_as_of: null` ou `stale: true` falham.
A decisão de frescor usa `meta.sources[].stale`, calculado pela API em
`src/domain/freshness.ts`: mais de 48 horas é stale; exatamente 48 horas ainda
é fresco. Não se recalcula idade usando o relógio do runner. Uma última coleta
`failed` ou em andamento pode coexistir com dados frescos do último sucesso e
não causa falha por si só. Ao mudar as fontes ou o contrato, atualizar o
validador e as fixtures juntos.

## Validação local sem produção

```sh
node --test scripts/verify-health.test.mjs
```

As fixtures em `scripts/fixtures/` reproduzem os campos atuais das rotas. Os
testes usam somente servidores HTTP efêmeros em `127.0.0.1`, incluindo o receptor
do sinal de sucesso. Cobrem sucesso, coleta recente falha com dados frescos,
stale, fontes incompletas/duplicadas, HTTP/JSON inválidos, timeout antes dos
headers e durante o corpo, resposta lenta e falha do receptor. Não precisam de
Postgres, credenciais, produção, Healthchecks real ou Actions remoto.

## Dependências e validação externa pendente

A implementação local depende do status da #22, já presente neste código, e da
**#28** para uma API publicada e acessível. O provisionamento externo da #13
precisa ser reconciliado com o bootstrap Neon e logins já documentados; este
arquivo não confirma contas, secrets ou deploy. Não modificar credenciais nesta
entrega. A integração e validação global ficam com o Codex.

Após aprovação para operar o ambiente real, o responsável deverá configurar a
origem e o secret acima, habilitar notificações de falha do GitHub Actions e
configurar o Healthchecks para período de seis horas com margem para cold start
e atrasos do agendador. O workflow apenas falha o job: entrega de e-mail depende
das preferências de notificação e da conta destinatária.

Ainda é necessário verificar o primeiro acesso após ociosidade, o sinal real de
sucesso e, em exercício autorizado e controlado, uma falha com recebimento do
e-mail do Actions e a ausência de sinal com alerta do Healthchecks. Esse último
critério da #29 permanece **pendente de validação externa**. Não foi provocado
incidente remoto, disparado alerta, enviado e-mail nem acionado workflow remoto
durante os testes locais.
