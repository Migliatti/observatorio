# Coleta diária

O workflow [collect.yml](../.github/workflows/collect.yml) roda diariamente às
06:17 UTC (03:17 em São Paulo). Também oferece `workflow_dispatch`, sem parâmetros:
uma execução sempre tenta Exoplanet Archive e NeoWs em jobs independentes, pelo
CLI `npm run collect -- <source>`, usando Node 24 e `npm ci`. Não roda em push ou PR.
Os jobs aceitam somente a ref `main`; selecionar outra branch manualmente deixa
os jobs ignorados. A integração deste arquivo na branch padrão habilita a agenda.

## Pré-requisitos

Configure no repositório, como Actions secrets (nunca em YAML ou logs):

| Secret | Uso |
| --- | --- |
| `COLLECTOR_DATABASE_URL` | URL Postgres **direta**, com TLS, role `observatorio_collector`; sem `-pooler` no host |
| `NASA_API_KEY` | Chave NASA, entregue somente ao passo de coleta NeoWs |
| `HEALTHCHECKS_COLLECT_URL` | URL HTTPS de ping do check de coleta **já existente**, compartilhado pelas duas fontes |

Os papéis e logins dependem do bootstrap descrito em
[database-roles.md](database-roles.md). As migrations necessárias devem estar
aplicadas previamente; este workflow não migra o banco nem recebe credenciais
de owner, migrator, API ou gestão de chaves. O preflight verifica formato, papel
e hostname antes de chamar o CLI, sem conectar nem imprimir a URL. A conexão
direta é necessária para os advisory locks por sessão. O preflight não comprova
os grants efetivos nem que o destino é o banco correto.

## Sucesso das duas fontes e alertas

O check é único: somente o job `signal`, dependente do sucesso de **ambos** os jobs
de coleta, envia o ping. Isso adapta o critério original da #27 (um check por fonte)
ao check compartilhado disponível. Não há ping individual, `/start`, `/fail` ou
execução incondicional que possa encobrir uma falha parcial. Se uma fonte falhar,
for cancelada ou ignorada, o sinal não roda; a outra fonte pode terminar normalmente.

O CLI já retorna código diferente de zero em erro; os passos Bash usam o modo
estrito do Actions, sem `continue-on-error`, pipes ou tratamento que suprima a
falha. Secret ausente ou configuração inválida também falha o passo. Erros HTTP
ou de transporte no ping fazem `signal` falhar, com tentativas limitadas e sem
imprimir a URL secreta. As coletas já concluídas não são revertidas por erro no ping.

No Healthchecks, manter o check existente com período de 24 h e tolerância de
aproximadamente 12 h (alerta após cerca de 36 h sem sucesso completo), com canal
de alerta configurado. O check detecta falha parcial e ausência de execuções;
notificações imediatas de falha dependem das preferências de notificações do
GitHub Actions do responsável. O workflow não envia e-mails diretamente.

## Concorrência e permissões

Um grupo fixo de concorrência serializa execuções agendadas e manuais; uma nova
execução não cancela a coleta em andamento. O Actions mantém no máximo uma
execução pendente nesse modo e pode substituí-la por outra mais recente.
Os jobs das duas fontes podem rodar em paralelo; os advisory locks existentes
protegem cada fonte também contra outros processos. Cada coleta tem timeout de
30 minutos; o sinal, de 3 minutos. O token só recebe `contents: read`, checkout não
persiste credenciais e secrets são limitados aos passos que precisam deles.

## Operação e validação pendente

Depois de autorização operacional e integração, executar manualmente em `main`
e conferir ambos os jobs, os registros `ingestion_run` com status `succeeded`
para as duas fontes, os dados no Neon e o ping recebido no check existente.
Não registrar URLs, chaves nem senhas como evidência. Conferir depois a execução
agendada e as configurações de período, tolerância e notificações do check.
Não provocar falhas em produção para testar alertas. Para repetir uma coleta
completa, preferir nova execução ou “Re-run all jobs”; “Re-run failed jobs” pode
reaproveitar resultados de jobs bem-sucedidos da tentativa anterior da mesma run.

A implementação da #27 foi preparada sem coleta real, ping remoto, alteração de
secrets, criação de checks ou disparo remoto. O bootstrap documentado não comprova
que todos os secrets e alertas estão prontos; o status desatualizado da #13 precisa
ser reconciliado pelo responsável. A aceitação que exige execução real permanece
pendente. Os testes locais não substituem a avaliação do DAG pelo GitHub Actions.

Validação local isolada, sem Postgres nem acesso remoto:

```sh
npm run test:fast -- src/collect/workflow.unit.test.ts
npm run typecheck
npm run lint
```
