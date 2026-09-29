# Publicação com Supabase e Render

## 1. Obter a conexão do Supabase

1. Abra o projeto no Supabase.
2. Clique em **Connect**, no topo da página do projeto.
3. Escolha **Session pooler** e o formato **URI**.
4. Substitua o marcador de senha pela senha do banco definida ao criar o projeto.
5. Guarde a URI em local privado. Ela começa com `postgresql://`.

O endereço público do projeto, como `https://...supabase.co`, não é a conexão PostgreSQL e não deve ser usado como `DATABASE_URL`.

## 2. Testar a conexão localmente (opcional)

No PowerShell, somente durante o terminal atual:

```powershell
$env:DATABASE_URL = "postgresql://..."
$env:SESSION_SECRET = "uma-chave-aleatoria-longa"
npm start
```

Ao iniciar corretamente, o terminal mostra `PostgreSQL conectado e estrutura verificada.`. O backend cria as tabelas e importa filiais, capacidades e usuários automaticamente.

Nunca salve a URI real em `.env.example`, no GitHub ou em mensagens públicas.

## 3. Publicar o código em um repositório privado

Envie o conteúdo desta pasta a um repositório privado no GitHub. Os arquivos `.env` e `node_modules` já estão ignorados.

## 4. Criar o Web Service no Render

1. No Render, escolha **New > Web Service**.
2. Conecte o repositório privado.
3. Selecione Node.js.
4. Build Command: `npm install`.
5. Start Command: `npm start`.
6. Health Check Path: `/api/health`.
7. Cadastre as variáveis abaixo.

| Variável | Valor |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | URI privada copiada do Supabase |
| `SESSION_SECRET` | chave aleatória longa, exclusiva do sistema |
| `DB_POOL_MAX` | `10` |

Para gerar `SESSION_SECRET` no PowerShell:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

## 5. Validar a publicação

1. Abra `/api/health`; a resposta deve informar `"database":"postgresql"`.
2. Entre com o administrador e confirme as 11 filiais.
3. Entre com uma conta de filial e confirme que somente a própria filial aparece.
4. Faça uma leitura de teste e confirme que ela continua disponível após reiniciar o serviço.
5. Encerre a sessão e confirme que o acesso protegido é bloqueado.

## Recuperação

Se a implantação falhar, consulte os logs do Render. Mensagens sobre `DATABASE_URL` ou `SESSION_SECRET` indicam variável ausente. Erros de autenticação do banco normalmente indicam senha incorreta ou URI copiada sem substituir o marcador de senha.
