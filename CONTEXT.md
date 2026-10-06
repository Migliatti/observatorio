# Observatório

Agregador de dados astronômicos que coleta fontes públicas (NASA e afins), guarda o histórico e os serve por uma API própria a outros projetos, como o kepler-lab.

## Language

**Fonte**:
Serviço externo de onde os dados são coletados. No v1: NASA Exoplanet Archive e NeoWs.
_Avoid_: provedor, upstream, API externa

**Consumidor**:
Projeto ou pessoa que lê a API do Observatório com uma chave própria. O primeiro é o kepler-lab.
_Avoid_: cliente, usuário

**Chave de API**:
Credencial que identifica um consumidor e conta o seu uso. Não é segredo quando embutida num aplicativo de navegador; serve para limitar e revogar.
_Avoid_: token, senha, credencial

**Coleta**:
Uma execução que busca dados de uma fonte e os grava, registrada com início, fim, resultado e contagens.
_Avoid_: sync, ingestão, job

**Frescor**:
Quão recente é o dado servido: o momento da última coleta bem-sucedida da fonte.
_Avoid_: idade, atualização

**Dado desatualizado**:
Dado de uma fonte cuja última coleta bem-sucedida passou de duas vezes o intervalo de coleta. É servido mesmo assim, marcado como tal.
_Avoid_: dado velho, expirado, stale

### Exoplanetas

**Exoplaneta**:
Planeta confirmado fora do Sistema Solar, identificado pelo nome que o Exoplanet Archive lhe dá.
_Avoid_: planeta (sozinho)

**Planeta removido**:
Exoplaneta que deixou de constar na fonte, por exemplo por reclassificação como falso positivo. É mantido e marcado, nunca apagado.
_Avoid_: planeta deletado, planeta inválido

**Revisão**:
Versão anterior dos parâmetros de um exoplaneta, guardada quando uma coleta detecta que algum valor mudou.
_Avoid_: versão, snapshot, auditoria

### Asteroides

**Asteroide**:
Objeto próximo da Terra catalogado pelo NeoWs, identificado pelo seu código do JPL.
_Avoid_: NEO, objeto

**Aproximação**:
Passagem de um asteroide perto da Terra numa data. Identificada pelo asteroide e pela data; a previsão é reescrita a cada coleta até a data passar, e depois fica congelada.
_Avoid_: encontro, passagem, evento

### Histórico

**Histórico**:
O que o Observatório lembra além do estado atual: as aproximações passadas, as revisões dos exoplanetas e quando cada registro foi visto pela primeira e pela última vez.
_Avoid_: log, arquivo

### Nomes na API

Os termos acima aparecem em inglês na API: **exoplaneta** é `exoplanet`, **aproximação** é `close_approach`, **revisão** é `revision`, **planeta removido** é `removed_at` preenchido, **frescor** e **dado desatualizado** são `data_as_of` e `stale`.
