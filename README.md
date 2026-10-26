# TUGAS — casa de apostas

Jogos e odds ao vivo (feed ESPN), contas no **Firebase**, depósitos por **PIX (BravoPay)**
e saques **pagos à mão pela equipa** no painel `/admin`.
Sem chave da BravoPay, depósitos e saques ficam indisponíveis.

## Colaboradores: testar no seu computador (sem chaves)

Não precisa do `.env` nem da chave do Firebase. Usa uma base de dados de **teste** (apagada ao fechar),
sem dinheiro real e sem tocar na produção.

1. Instale o [Node.js 22.13+](https://nodejs.org), o [Java 11+](https://adoptium.net) e o Firebase CLI: `npm install -g firebase-tools`
2. Na pasta do projeto: `npm install` e depois `npm run dev`
3. Abra http://localhost:3100, crie uma conta de teste e use "+ R$ 1.000 teste" para ter saldo.

Não use `npm start` nem `iniciar.bat`: esses ligam à base de dados **real** e exigem a chave da conta de serviço.

## 1. Configuração (uma vez)

### Firebase (projeto `golaco-ac746`)

1. **Firestore**: https://console.firebase.google.com/project/golaco-ac746/firestore → *Criar banco de dados*
   (modo produção, região `southamerica-east1` / São Paulo).
2. **Regras**: *Firestore > Regras* → cole o conteúdo de `firestore.rules` → **Publicar**.
   Com pagamentos reais, o servidor recusa arrancar se as regras estiverem abertas.
3. **Login**: *Authentication > Sign-in method* → ative **E-mail/senha**.
4. **E-mails em português**: *Authentication > Templates* → idioma **Português (Brasil)**.
   Pode mudar o nome do remetente para "TUGAS".
5. **Chave do servidor**: *Configurações do projeto > Contas de serviço* → **Gerar nova chave privada** →
   guarde nesta pasta como `firebase-service-account.json`. Nunca a partilhe (já está no `.gitignore`).

### `.env`

Copie `.env.example` para `.env` e preencha pelo menos:

- `ADMIN_EMAILS` — o(s) e-mail(s) da equipa que entram no painel.
- `BRAVOPAY_API_KEY` — de https://bravopay.club/dashboard/api-keys
- `COMPANY_NAME`, `COMPANY_CNPJ`, `SPA_LICENSE`, `SUPPORT_EMAIL` — aparecem no rodapé e nas páginas legais.

Depois corra **`npm run verificar`**: confere Firebase, regras, login, BravoPay, admins e dados da empresa,
e diz exatamente o que falta.

## 2. Teste com depósito real (no seu computador)

1. `iniciar.bat` (ou `npm install` e `npm start`) e abra http://localhost:3000
2. **Crie a sua conta** com o e-mail que pôs em `ADMIN_EMAILS` e **confirme o e-mail** (link na caixa de entrada / spam).
3. **Depositar → R$ 10** → informe o seu CPF → pague o PIX no app do banco **a partir de uma conta no seu CPF**.
   O saldo aparece em poucos segundos (em localhost o site consulta a BravoPay sozinho; não precisa de webhook).
4. Faça uma aposta pequena.
5. **Sacar → R$ 30** (mínimo) → o pedido fica *pendente* e o valor sai do saldo.
6. Abra http://localhost:3000/admin → **Saques** → *Assumir* → faça o PIX para o CPF mostrado →
   *Marcar como pago* com o ID da transação (E2E). O jogador vê "pago" no Extrato.
7. Confira no Firebase (*Firestore*) as coleções `users`, `deposits`, `withdrawals` e no painel da BravoPay a cobrança.

## 3. Saques (manuais)

- O jogador pede o saque → o valor sai do saldo e fica reservado → estado **pendente**.
- Enquanto está pendente, o jogador pode cancelar no Extrato (o valor volta).
- No painel, a equipa:
  - **Assumir** → "em processamento" (avisa os colegas para ninguém pagar duas vezes; o jogador já não pode cancelar);
  - faz o PIX **para a chave CPF do titular** (é a única chave aceite);
  - **Marcar como pago** com o ID E2E / referência do comprovante; ou
  - **Recusar** com motivo → o valor volta ao saldo e o motivo aparece no extrato do jogador.
- Para sacar, o jogador precisa de ter feito um depósito (regista o CPF) e de ter o e-mail confirmado.
- Cada pedido aparece também no terminal do servidor: `[Saque] Novo pedido ...`.

## 4. Painel da equipa (`/admin`)

- **Saques**: fila por tratar (mais antigos primeiro), pagos, recusados, cancelados.
- **Depósitos**: todos os PIX e os que ficaram *em revisão* (valor pago diferente do pedido) para creditar ou descartar.
- **Jogadores**: procurar por e-mail, CPF, nome ou ID; ver saldo, extrato, apostas, depósitos e saques;
  **ajustar saldo** (com motivo) e **bloquear/desbloquear** a conta.
- **Esportes e mercados**:
  - *Modalidades e campeonatos* — criar modalidades novas (Tênis, MMA, eSports...) e campeonatos; ocultar/mostrar no site.
  - *Eventos da equipa* — criar um evento num campeonato (da equipa ou da ESPN) e atualizar à mão o estado
    (por começar / ao vivo / encerrado), o placar e o tempo.
  - *Mercados em jogos reais* — acrescentar mercados próprios (escanteios, cartões...) a um jogo do feed da ESPN.
  - *Longo prazo* (em "+ Novo evento") — evento sem adversário (ex.: "Campeão do SIX Major 2026") com prazo de
    fechamento e lista de participantes com odds. Depois do prazo as apostas fecham sozinhas; a equipa liquida
    quando souber o resultado. Qualquer mercado (também num jogo) pode ter o seu próprio prazo ("Fecha em").
  - Em cada evento: criar mercados com seleções e **odds definidas pela equipa**, aposta máxima opcional, mudar odds,
    suspender/abrir (um ou todos), ver as apostas e o valor a pagar por seleção e **liquidar** (Ganhou / Perdeu / Devolvida).
    As apostas desse mercado são pagas logo a seguir. Mercados com apostas em aberto não podem ser apagados.
  - **Odds automáticas ao vivo** (eSports e outros jogos por rounds, `livemodel.js`): no campeonato definem-se as
    *regras do jogo* (rounds para ganhar um mapa, prorrogação, melhor de N mapas, margem; modelos prontos para
    Rainbow Six, CS2 e Valorant). Cada mercado recebe um tipo (Vencedor da partida, Total/Handicap de rounds do mapa,
    Vencedor do mapa, Total/Handicap de mapas) e o lado/linha de cada seleção é lido do nome ("Mais de 10.5", "FaZe -2.5").
    A força das equipas é calibrada pelas odds do Vencedor; ao vivo, a equipa marca cada round (+1 / desfazer) e todas
    as odds automáticas são recalculadas. Handicaps e totais têm **linhas móveis**: a cada round o motor oferece a
    linha equilibrada e as vizinhas e tira do site as antigas (as apostas feitas nelas continuam valendo); linhas
    com odd abaixo da *odd mínima* do campeonato (1.15 por defeito) ficam bloqueadas. Na *reta final* do mapa (ex.: 5 rounds no R6)
    fica só a linha equilibrada e no match point/prorrogação os handicaps e totais do mapa saem do site. No site,
    totais e handicaps aparecem em tabela (uma linha por fila).
    Em **melhor de 3, 5 ou 7**, ao ligar as odds automáticas abrem-se os mercados de cada mapa (vencedor, total e
    handicap de rounds) e os da série (total e handicap de mapas). Mapas terminados saem do site à espera de
    liquidar; mapas que já não vão ser jogados são anulados (devolvidos). No site, os mercados vêm por blocos: Partida, Mapa 1, Mapa 2...
    **Pacote padrão** (abre ao ligar as odds automáticas, também em melhor de 1; odds pela força das equipas):
    ao vivo e antes do jogo — corrida a X rounds, placar exato do 1º tempo (R6: 6 rounds; fecha no intervalo),
    placar exato da série, ambas ganham um mapa; só antes do jogo —
    margem de vitória, placar exato do mapa e rounds de cada equipa. "Liquidar tudo pelo placar" fecha de uma vez o que o placar já decidiu. O mapa/partida fecha sozinho e
    o resultado de cada mercado vem pré-preenchido na liquidação.
- **Registo**: todas as ações da equipa (quem, quando, o quê).

## 5. Jogo responsável (área do jogador)

Limite de depósito (24h), limite de perda por dia e por mês, lembrete de tempo de jogo e pausa/autoexclusão
(24h a 5 anos, sem cancelamento). Baixar um limite vale na hora; subir ou remover só vale 24h depois.

## 5b. Mercados calculados (futebol, só antes do jogo)

O feed só traz Vencedor, Handicap e Total. Os mercados **Empate Anula**, **Ambas Marcam**, **Totais extra (0.5 a 4.5)**,
**Resultado + Total 2.5** e **Placar Exato** são calculados por um modelo Dixon-Coles ajustado às odds reais
(`public/markets.js`, função `deriveSoccer`). A margem da casa (`DERIVED_MARGIN`): Empate Anula 5,5%, Ambas Marcam 6,5%,
Totais 7%, Resultado+Total 11%, Placar Exato 22% — aplicada pelo método "power" e arredondada para baixo na escala de odds.
Aposta máxima R$ 200 e prêmio máximo R$ 10.000 nestes mercados (`DERIVED_MAX_STAKE`, `DERIVED_MAX_WIN` no `.env`).
Saem do ar quando o jogo começa. Ao contratar um fornecedor de odds, estes mercados devem passar a vir dele.

## 6. Onde fica cada coisa no Firestore

| Coleção | Conteúdo |
|---|---|
| `users/{uid}` | Perfil: nome, e-mail, nascimento, CPF, **saldo** (centavos), limites, pausa, bloqueio |
| `users/{uid}/transactions` | Extrato (depósitos, apostas, prêmios, cash out, saques e o seu estado) |
| `users/{uid}/bets` | Apostas do jogador |
| `openBets` | Apostas em aberto (liquidação automática) |
| `deposits` | Cobranças PIX |
| `withdrawals` | Pedidos de saque: `PENDING` → `PROCESSING` → `PAID` / `REJECTED` / `CANCELED` |
| `cpfs` | 1 CPF por conta |
| `sessions` | Sessões de login |
| `webhookEvents` | Webhooks da BravoPay já processados |
| `adminLogs` | Ações da equipa |
| `catalogSports`, `catalogLeagues` | Modalidades e campeonatos criados pela equipa |
| `manualEvents` | Eventos criados pela equipa, com os seus mercados (`markets`) |
| `manualMarkets/{id do jogo}` | Mercados da equipa em jogos reais da ESPN |

Valores em **centavos** (`11895` = R$ 118,95). As contas (e-mail/senha) ficam em *Authentication*.

## 7a. Publicado no Google Cloud Run

- Endereço: https://tugas-665257038137.southamerica-east1.run.app (painel: `/admin`)
- Serviço `tugas`, região São Paulo, 1 instância sempre ligada, CPU sempre ativa.
- **Publicar uma atualização:** `npm run deploy` (lê o `.env`; as chaves vão para o Secret Manager).
- **Ver os logs:** `gcloud run services logs read tugas --region=southamerica-east1 --limit=100`
  ou Console Google Cloud > Cloud Run > tugas > Registos.
- Não corra o servidor local (`npm start`) ao mesmo tempo com o `.env` de produção: o sistema foi feito para uma instância só.
- Domínio próprio: o Cloud Run não liga domínios em São Paulo; usa-se o **Firebase Hosting à frente**
  (`firebase.json` reencaminha tudo para o serviço `tugas`; o cookie de sessão chama-se `__session` por isso).
  Endereço via Hosting: https://golaco-ac746.web.app — o domínio próprio (ex.: o domínio da Tugas) liga-se em
  Console Firebase > Hosting > Adicionar domínio personalizado. Só é preciso republicar o Hosting se mudar o `firebase.json`:
  `npx firebase-tools deploy --only hosting`.

## 7. Pôr no ar (produção)

- Servidor Node.js 22+ (VPS, Render, Railway, Google Cloud Run com 1 instância...) atrás de **HTTPS** no seu domínio `.bet.br`.
  Defina `TRUST_PROXY=1` se houver proxy à frente, e `SITE_URL=https://seu-dominio`.
- Adicione o domínio em *Firebase > Authentication > Configurações > Domínios autorizados*.
- Crie o webhook na BravoPay para `https://seu-dominio/api/webhooks/bravopay` e ponha o segredo em `BRAVOPAY_WEBHOOK_SECRET`.
- Corra **uma única instância** do servidor (guarda caches em memória).
- Ative cópias de segurança do Firestore (*Firestore > Recuperação de desastres*).

## Ficheiros

| Ficheiro | O que faz |
|---|---|
| `server.js` | Servidor: contas, sessões, carteira, apostas, liquidação, depósitos, pedidos de saque, jogo responsável |
| `admin.js` | API do painel da equipa |
| `catalog.js` | API do painel: modalidades, campeonatos, eventos e mercados da equipa |
| `firebase.js` | Ligação ao Firebase (Firestore + Authentication + e-mails) |
| `bravopay.js` | Cliente da API BravoPay e verificação da assinatura dos webhooks |
| `scripts/verificar.js` | `npm run verificar` — confere a configuração |
| `firestore.rules` | Regras do Firestore (bloqueia acesso direto) |
| `public/` | Site do jogador (`index.html`, `app.js`), painel (`admin.html`, `admin.js`), páginas legais |

## Notas

- Placares e odds: feed público e não oficial da ESPN. Para operar em escala, contrate um fornecedor oficial de odds/dados.
- As páginas legais (`/termos`, `/privacidade`, `/jogo-responsavel`) são modelos: devem ser revistas pelo seu jurídico.
- A pasta `data/` é da versão antiga (SQLite) e já não é usada.
