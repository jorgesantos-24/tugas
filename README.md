# TUGAS — casa de apostas

Jogos e odds ao vivo (MoviOdds, odds da bet365), contas no **Firebase**, depósitos por **PIX (BravoPay)**
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

- Jogos, placares, odds e resultados: MoviOdds (grátis, não oficial, odds da bet365), em `feeds/moviodds.js`. Para trocar de fornecedor muda-se só esse ficheiro. Para operar em escala, contrate um fornecedor oficial de odds/dados.
- Tempo real: o servidor fica ligado ao WebSocket da MoviOdds (`feeds/moviows.js`) e segue os jogos ao vivo e os que começam nos próximos 15 min — odds, placar e estatísticas chegam em ~1 s. Com a ligação ativa, o pedido ao vivo de 5 em 5 s traz só placar e relógio (sem odds). Se a ligação cair, tudo volta sozinho aos pedidos normais. O navegador recebe as mudanças por `GET /api/stream` (Server-Sent Events, comprimido); os jogos abertos (página do jogo, boletim, apostas) recebem os mercados completos no mesmo fluxo. O estado aparece no painel (cartão "Odds ao vivo").
- Liquidação antecipada (`early.js`): seleções que já não podem mudar são pagas ~2,5 min depois de ficarem decididas, sem esperar pelo fim do jogo — totais/ambas marcam/placar exato (futebol só antes dos 90'), total de pontos (basquete), sets e games terminados (ténis), mapas (e-Sports CS2/Valorant), e os mercados por parte do jogo e combinações (`feeds/auto.js`: 1º/2º tempo, quartos, períodos, escanteios, rondas, resultado + ambas marcam, faixas de gols...). Futebol e hóquei esperam ainda que a bet365 reabra os mercados depois do gol (VAR). Vencedor do jogo e handicaps continuam no fim.
- Placar de cada parte (`feeds/parts.js`): vem das ESTATÍSTICAS da MoviOdds, não dos "periods" do resultado — estes põem os gols do acréscimo e os pontos do fim de cada quarto na parte seguinte (comparado com a ESPN em 24-26/10/2026: errados em 6/6 e 14/14 casos; as estatísticas certas em todos). Basquete e hóquei: os pontos por período têm de bater com as linhas acumuladas "Score After...".
- Futebol — jogadores (`feeds/players.js`): remates, remates à baliza, marcadores (a qualquer momento, 2+/3+), gols/assistências, faltas cometidas/sofridas, desarmes, defesas, passes e cartão de jogador, liquidados com as estatísticas por jogador da MoviOdds (conferidas com a ESPN: 100% iguais). Só abrem nas ligas em que a fonte trouxe essas estatísticas nos últimos 7 dias (≥3 jogos, ≥90%), ou ao vivo quando o jogo já as traz. Jogador que não jogou → devolvida; nome não encontrado → equipa. Não abrem: 1º/último marcador, "um dos dois", cabeceamentos, remates de fora da área, "expulso" (a fonte falha vermelhos).
- Futebol — prolongamento e penáltis (`feeds/extratime.js`, `feeds/espn.js`): abrem sempre que a bet365 os oferece. A MoviOdds só regista os 90 minutos, por isso o resultado (prolongamento, penáltis, quem passa) vem da ESPN; sem resultado na ESPN em 6 h, ou sem regra (cada penálti, morte súbita...), ficam para a equipa. `ESPN_RESULTS=0` desliga.
- Apostas ao vivo: espera por modalidade (`LIVE_DELAY_*`) e vigilância (`livewatch.js`, separador "Ao vivo suspeitas" no painel).
- Saúde da fonte: se a MoviOdds avisar que o ao vivo de uma modalidade está degradado ou parado, as odds ao vivo dessa modalidade ficam bloqueadas até voltar ao normal.
- As páginas legais (`/termos`, `/privacidade`, `/jogo-responsavel`) são modelos: devem ser revistas pelo seu jurídico.
- A pasta `data/` é da versão antiga (SQLite) e já não é usada.
