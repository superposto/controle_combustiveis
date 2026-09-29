# FuelControl — Frontend, API e PostgreSQL

Sistema web em JavaScript para controle diário de combustíveis nas 11 filiais informadas.

## Executar localmente

Requer Node.js 18 ou superior.

```bash
npm install
npm start
```

Depois, acesse `http://127.0.0.1:4173`.

Sem `DATABASE_URL`, o sistema usa `data/db.json` somente para desenvolvimento local. Quando `DATABASE_URL` está configurada, o backend usa PostgreSQL e cria/atualiza as tabelas automaticamente.

## Estrutura

```text
controle-combustivel-web/
├── data/db.json  # dados iniciais e modo local
├── database.js   # conexão, estrutura, importação e transações PostgreSQL
├── .env.example  # nomes das variáveis de ambiente
├── DEPLOY-SUPABASE-RENDER.md
├── CREDENCIAIS-INICIAIS.md
├── index.html    # estrutura das telas
├── styles.css    # sistema visual e responsividade
├── script.js     # integração do front-end com a API
├── server.js     # servidor HTTP, API REST e validações
└── package.json  # comandos e dependências
```

## Dados cadastrados

Foram registradas as filiais 02 a 12, seus nomes/cidades e as capacidades de Diesel S500, gasolina comum, Diesel S10, gasolina aditivada e etanol.

A Filial 12 — Erechim possui capacidade de 15.000 L para gasolina comum, 15.000 L para diesel S10 e 15.000 L para gasolina aditivada, totalizando 45.000 L.

## API

- `GET /api/health` — disponibilidade e versão do modelo.
- `POST /api/auth/login` — autenticação e criação de sessão.
- `GET /api/auth/me` — usuário autenticado e respectivo escopo.
- `POST /api/auth/logout` — encerramento da sessão.
- `GET /api/meta` — combustíveis, perfis e limites de alerta.
- `GET /api/branches` — filiais, capacidades e verificações cadastrais.
- `GET /api/dashboard?date=AAAA-MM-DD` — resumo diário e leitura mais recente de cada filial.
- `GET /api/readings?branch=FILIAL%2002&date=AAAA-MM-DD` — histórico filtrável.
- `POST /api/readings` — cria uma leitura e registra auditoria.

Todas as rotas de negócio exigem sessão autenticada. A conta administrativa recebe os dados das 11 filiais. Cada conta de filial recebe exclusivamente seu cadastro, painel, histórico e permissão de lançamento. A API devolve `403` quando uma conta tenta informar ou consultar outro código de filial.

## Segurança implementada

- Senhas armazenadas como hash scrypt com salt exclusivo por usuário.
- Cookie de sessão `HttpOnly` e `SameSite=Strict`, com validade de oito horas.
- Sessões opacas geradas com 256 bits aleatórios.
- Limite de cinco tentativas incorretas por usuário e endereço, seguido de bloqueio por cinco minutos.
- Mensagem genérica para usuário ou senha incorretos.
- Restrição de filial aplicada no servidor e refletida na interface.
- Encerramento de sessão com invalidação do token.
- Em PostgreSQL, somente o HMAC do token de sessão é armazenado.
- Sessões persistentes continuam válidas após reinícios do servidor.
- `DATABASE_URL` e `SESSION_SECRET` são exigidas quando `NODE_ENV=production`.

As credenciais de primeiro acesso estão em `CREDENCIAIS-INICIAIS.md`. Esse arquivo deve permanecer restrito.

## Regras implementadas

- Data, hora, filial e responsável são obrigatórios.
- Medições e conversões não podem ser negativas.
- O volume convertido não pode superar a capacidade do tanque.
- Combustível sem tanque cadastrado aceita somente zero.
- Leituras da mesma filial, data e horário não podem ser duplicadas.
- Totais e ocupação são calculados exclusivamente pelo servidor.
- Lançamentos são acrescentados ao histórico e não sobrescrevem registros anteriores.
- Cada criação gera uma entrada no log de auditoria.
- Abaixo de 25% é nível crítico; de 25% a 39,9% requer atenção.

## PostgreSQL

- O banco é inicializado de forma idempotente ao iniciar o servidor.
- Filiais, capacidades e usuários fixos são sincronizados a partir dos dados iniciais.
- Leituras, medições, sessões e auditoria ficam armazenadas no PostgreSQL.
- Cada nova leitura e seu registro de auditoria são gravados na mesma transação.
- A restrição de leitura duplicada também existe no próprio banco.

## Limites atuais

- Sem `DATABASE_URL`, o armazenamento local continua sendo o arquivo JSON e as sessões ficam em memória.
- Ainda não existe troca ou recuperação de senha pela interface.
- Não há edição nem exclusão de leituras, preservando o histórico original.
- A importação automática do Google Sheets ainda não foi ativada.

Consulte `DEPLOY-SUPABASE-RENDER.md` para conectar o Supabase e publicar no Render.
