# Enviar o FuelControl ao GitHub

O repositório deve ser **privado**, porque o sistema contém a estrutura de autenticação e os hashes das contas fixas.

## Opção mais simples: GitHub Desktop

1. Instale e abra o GitHub Desktop.
2. Entre na sua conta do GitHub.
3. Extraia o pacote `controle-combustivel-github.zip`.
4. No GitHub Desktop, escolha **File > Add local repository**.
5. Selecione a pasta extraída.
6. Se o programa informar que ainda não é um repositório, escolha **Create a repository**.
7. Use o nome `controle-combustivel`.
8. Faça o primeiro commit com a mensagem `Sistema inicial de controle de combustíveis`.
9. Clique em **Publish repository**.
10. Marque **Keep this code private** antes de publicar.

## Depois do GitHub

No Render, escolha **New > Blueprint**, conecte o repositório e confirme o arquivo `render.yaml`. O Render solicitará somente a variável secreta `DATABASE_URL`; `SESSION_SECRET` será gerada automaticamente.

Use como `DATABASE_URL` a URI do Session pooler do Supabase, preenchida com a senha e terminada em `?sslmode=require`.

Não envie ao GitHub arquivos `.env`, a senha do Supabase ou `CREDENCIAIS-INICIAIS.md`.
