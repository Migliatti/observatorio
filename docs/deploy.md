# Pipeline de deploy

Preparação da #28: nenhum deploy ou migration de produção foi executado nesta entrega.
O CI geral permanece em `.github/workflows/ci.yml`, sem alterações.

## Fluxo e bloqueios

Um push em `main` executa o workflow **CI**. Somente sua conclusão `success`
dispara o job de `.github/workflows/deploy.yml`, via `workflow_run`; PRs, forks,
outras branches e CI cancelado/falho não recebem secrets de deploy. O nome `CI`
é parte desse contrato: se mudar, atualizar `workflows: [CI]`.

O job usa o environment GitHub **production**, serializa execuções sem cancelar
migrations em curso e confere o SHA atual de `main` antes do checkout, antes da
migration e antes do hook. Faz checkout do `head_sha` aprovado, instala com
`npm ci`, valida configuração, executa `node --import tsx src/db/migrate.ts` e
só depois solicita o deploy. Não executa `db:codegen` em produção: os tipos devem
vir do commit revisado. Qualquer falha interrompe os próximos passos. Logs brutos
da migration são temporários, apagados e não publicados para evitar exposição de
dados de conexão; investigar falhas em sessão privada com o operador.

O hook recebe `ref=<head_sha>` para impedir que publique um commit diferente do
migrado. Não há retry automático do POST: um timeout pode ocorrer depois da
aceitação; conferir Render antes de repetir. HTTP 2xx significa solicitação
aceita, **não rollout concluído**. O job não monitora o rollout nem certifica a
saúde da versão publicada. Uma reexecução volta a conferir `main` e reaplica
somente migrations pendentes. Runs obsoletos falham sem fazer deploy.

Existe uma janela entre cada conferência do SHA e a operação seguinte; outro push
pode chegar durante a migration ou após a última conferência. O hook continua
fixado no SHA aprovado; expand/contract mantém a API antiga compatível. A fila do
Actions não substitui a verificação do SHA e não garante executar todos os pushes.
Mantenha todos os caminhos de deploy/migration sob este fluxo; deploy manual e
edições externas não participam da serialização.

## Configuração a cargo do operador (#13)

Nenhum valor deve ser colocado no repositório, issues, logs ou artifacts.

| Local | Nome/configuração | Requisito |
| --- | --- | --- |
| GitHub Actions (secrets de repositório ou do environment `production`) | `MIGRATOR_DATABASE_URL` | Neon **direto**, usuário `observatorio_migrator`, senha definida, database explícito e `sslmode=require`; rejeita hostname `-pooler` e owner |
| GitHub Actions (mesmo escopo) | `RENDER_DEPLOY_HOOK_URL` | Hook secreto HTTPS `api.render.com/deploy/srv-…?key=…` do serviço correto |
| GitHub environment | `production` | Restringir deployment branch a `main`; configurar proteções conforme política do repositório |
| Render | `API_DATABASE_URL` | URL **pooled** de `observatorio_api`; nunca owner/migrator |
| Render | `CORS_ORIGINS` | Origem HTTPS exata do kepler-lab publicado; múltiplas separadas por vírgula, sem wildcard; preencher explicitamente, sem depender do default de desenvolvimento |
| Render | `HOST` | `0.0.0.0` |
| Render | `PORT` | Usar a porta injetada pelo Render; a aplicação converte e valida o valor |
| Render | `LOG_LEVEL` | `info` (ou outro nível validado pela API) |
| Render | `TRUSTED_PROXIES` | Vazio até verificar os proxies reais; não confiar em todos por conveniência |

O workflow valida a forma das URLs sem abri-las ou imprimir valores; não comprova
identidade, grants, endpoint correto ou login. Se um formato de hook/host do
fornecedor mudar, atualizar a validação após consultar a documentação oficial.
O bootstrap owner é uma operação separada, já descrita em
[database-roles.md](database-roles.md): este pipeline recorrente **não aceita owner**.
Reconciliar o estado atual de bootstrap/logins com o responsável pela #13 antes
de habilitar o fluxo; a issue/comentário consultados ainda descrevem owner
temporário e logins pendentes. Não inferir o estado real a partir desse registro.

## Serviço Render existente

Configuração proposta para o serviço `observatorio`, ligado a
`Migliatti/observatorio`, branch `main`:

- Web Service, runtime Node, plano **Free**; build `npm ci && npm run build`, start
  `npm start`, health check path `/health`.
- **Auto-Deploy: Off** (Blueprint equivalente: `autoDeployTrigger: off`). Habilitar
  deploy automático, mesmo após checks, criaria um caminho que pode ignorar a
  migration. Não há fallback automático; se o hook não funcionar no plano real,
  manter o fluxo bloqueado e revisar a arquitetura.
- Node fixado em **24.21.0** por `.node-version`, também usado no deploy Actions.
  `NODE_VERSION` no Render tem precedência: remover override divergente ou fixar
  no mesmo patch. `engines.node >=24` sozinho não fixa o major/patch. CI existente
  continua usando Node 24; validar o patch efetivo no build do Render.
- Não configurar `preDeployCommand` (indisponível em Free), nem rodar migrations
  em build/start. Não cadastrar credenciais de migrator no Render.

Não incluímos `render.yaml`: o serviço já existe e estes parâmetros podem ser
revisados nele, sem introduzir sync/provisionamento e um primeiro deploy implícito.
A aplicação lê `PORT` e escuta `HOST`; `/health` retorna `{ "status": "ok" }` sem
consulta SQL. **No boot**, porém, o servidor aguarda `select 1` antes de escutar:
não promete health disponível quando o banco está indisponível no startup.

Neon: `connectionTimeoutMillis=10000`, até 5 tentativas no boot com backoff
exponencial e jitter (esperas máximas de 100/200/400/800 ms). Testes locais
comprovam a política e o health sem banco; não simulam o cold start real de Neon
e Render. Após o boot, não há retry transparente geral de consultas HTTP; uma
falha de banco ainda pode gerar erro de rota. Medir o primeiro acesso após
ociosidade antes de aceitar o critério de produção.

## Regra obrigatória: expand/contract

Toda migration deve funcionar com a versão **anterior** da API ainda em execução,
porque o banco muda antes do rollout e permanece alterado se o deploy falhar.

1. **Expandir:** adicionar tabelas/colunas opcionais ou defaults compatíveis;
   preservar nomes, tipos e permissões usados pela API antiga. Avaliar locks,
   tempo e volume de backfills na revisão; não misturar backfill longo com rollout.
2. Publicar código que suporte ambos os formatos; migrar dados e comprovar que a
   versão antiga não é mais usada, incluindo o alvo de rollback.
3. **Contrair em outro release:** só então remover/renomear campos, restringir
   nulabilidade ou retirar grants antigos. Justificar compatibilidade no review.

Não editar migrations já aplicadas. Falhas de migration impedem o hook; falhas de
deploy deixam o schema expandido para a versão anterior. Não executar down
automático. Reverter a API só é seguro enquanto seu schema continuar suportado;
preferir correção para frente. Para mudanças destrutivas, coordenar antes a
cobertura e o ensaio de restauração da #30 (backup não cobre chaves).

## Verificações locais desta entrega

Executadas em Node **24.21.0**, no floor `codex/issue-28-pipeline-deploy`:

- `npm run lint`, `npm run typecheck` e `npm run build`: sucesso.
- `npm run test:fast -- src/api/config.test.ts src/api/rate-limit.integration.test.ts`:
  **15 testes aprovados**, sem global setup de banco.
- `vitest run --config /private/tmp/observatorio-28/focused.config.mjs`:
  **4 testes aprovados** de `src/api/health.test.ts` e `src/db/connect.test.ts`.
  Configuração temporária sem global setup; health usa conexão inacessível e retry
  usa falhas locais simuladas. Nenhum Postgres compartilhado foi usado.
- `node --test /private/tmp/observatorio-28/simulate.mjs`: **22 testes aprovados**.
  O harness temporário lê o YAML real com detecção de chaves duplicadas, avalia
  o filtro do job, executa os scripts de validação/hook com URLs fictícias e
  `fetch` substituído, executa o shell da migration com CLI substituído e simula
  as três consultas de SHA. Comprova ordem migration/hook, falhas bloqueantes,
  rejeição de owner/pooler/TLS ausente, SHA fixo, preservação da chave do hook,
  remoção dos logs temporários e ausência dos valores fictícios no output.
- `git diff --check` e comparação de `.github/workflows/ci.yml` com `5b2b1fc`:
  sucesso; CI geral preservado.

Esses harnesses são evidência local temporária, não fazem parte do produto.
Não foram executados runner GitHub, `npm ci` em ambiente limpo, actionlint,
migrations reais nem rollout Render. Checkout/setup-node são inspecionados
estruturalmente; o simulador não os executa. A API publicada e seus fornecedores
continuam sujeitos à validação abaixo.

## Evidência documental e validação real pendente

Fontes oficiais consultadas em 2026-10-22:

- [GitHub: workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run):
  conclusão não implica sucesso; filtrar `conclusion` e origem. O arquivo precisa
  estar na branch padrão para receber o evento.
- [Render: deploy hooks](https://render.com/docs/deploy-hooks) e
  [deploys](https://render.com/docs/deploys): hook secreto e seleção por `ref`.
- [Render: Free](https://render.com/docs/free): sem pre-deploy command; serviço
  dorme após 15 minutos sem tráfego, retorno pode levar cerca de um minuto;
  há limites de horas/build/banda e suspensão sem método de pagamento.
- [Render: Node](https://render.com/docs/node-version) e
  [health checks](https://render.com/docs/health-checks): precedência de versão e
  configuração do health path. Render fornece subdomínio `onrender.com` e TLS
  conforme [Web Services](https://render.com/docs/web-services).

São capacidades documentadas, **não validações da conta ou produção**. O relato
histórico da #13 diz que `/health` foi salvo e o hook existe em Free; funcionamento,
TLS e ausência de exigência de cartão nessa conta ainda precisam de conferência
real pelo operador. Não prometemos disponibilidade ilimitada ou custo zero fora
das cotas.

Checklist para a validação autorizada futura (não executar nesta preparação):

- Confirmar com #13 o bootstrap e o login/grants efetivos do migrator direto e
  da API pooled, os nomes de secrets e o escopo do environment; sem ler valores
  para o relatório. Confirmar autodeploy Off, plano e comandos do serviço.
- Após integrar e autorizar operação, observar um push aprovado: migration antes
  do hook, SHA idêntico em CI/checkout/Render e aplicação saudável após rollout.
  Comprovar os caminhos de falha em ambiente isolado, sem provocar falha remota
  de produção. As simulações locais não substituem esse ensaio.
- Confirmar build Node 24.21.0, bind da porta, TLS `*.onrender.com`, health 200 e
  rota de dados autenticada; CORS aceita só a origem configurada nas rotas de dados.
- Após ociosidade, medir cold start de Render/Neon e primeira rota de dados;
  registrar latência e eventuais erros, sem concluir apenas pelo health.
- Coordenar #30 para backup/restore; não usar banco compartilhado de testes.

Maestri indisponível nesta sessão (`Operation not permitted` no primeiro `list`);
dependências não foram confirmadas ao vivo com Lince/Arca. Relatório e commit
locais são entregues ao Codex para integração; nada foi publicado.
