# Salas de Conversação

Aulas de conversação com salas de 3–4 alunos separadas por nível (Básico / Intermediário), no estilo das salas do Google Meet, usando LiveKit Cloud para o vídeo.

## Como funciona
1. Você cria uma aula no painel e copia o **link próprio daquela aula** (quinta ≠ sexta).
2. O aluno abre o link, digita o nome e escolhe **Básico** ou **Intermediário**. Fica numa tela de "aguardando".
3. No painel você vê quem entrou. Define quantas salas quer (ou deixa "auto"), clica em **Distribuir automaticamente** e, se quiser, **arrasta alunos** entre as salas (ou usa o botão ⇄). Pode adicionar/remover salas.
4. **Iniciar aula** tranca a entrada: ninguém novo entra depois.
5. Durante a rodada as salas aparecem só com as iniciais dos alunos (sem consumir nada do LiveKit). Em cada sala você pode clicar em **Ver vídeo** / **Parar de ver vídeo**. O painel só se conecta às salas que você está vendo ou ouvindo. **Ouvir** liga o áudio só da sala escolhida; **Falar** abre seu microfone só para ela. Quando um aluno aperta **Chamar professor**, aparece um aviso no topo com **Atender**.
6. Ao fim da rodada 1, o sistema sugere as salas da rodada 2 sem repetir parceiros (você ainda pode ajustar). Depois, encerre a aula.

Use fones de ouvido ao ouvir/falar com uma sala, para evitar eco.

### Recursos durante a aula
- **Tema claro/escuro:** botão redondo no canto superior direito (professor e aluno). A escolha fica salva no navegador.
- **Chat por sala:** cada sala tem seu chat. Mensagens do professor aparecem em faixa escura com a etiqueta "PROFESSOR", e nomes que imitam o professor (Professor, Prof..., Admin) são recusados na entrada. No painel, o botão **Chat** de cada sala abre uma janela flutuante, com um contador de mensagens novas.
- **Transmissão:** marque as salas na caixinha no topo de cada uma (ou use Todas/Nenhuma). Daí você pode **ligar o microfone** para todas ou só as selecionadas, **compartilhar a tela** para todas ou só as selecionadas, e **enviar mensagem** às selecionadas ou a todas. Os alunos veem a tela em destaque, com botão de tela cheia.
- **Mensagem final:** no fim do painel, "Mensagem exibida aos alunos ao encerrar a aula": texto, link e o texto do botão. Vazio = mensagem padrão.

### Custos e limites da transmissão
- Microfone e tela conectam você às salas escolhidas, e isso consome minutos de participante no LiveKit enquanto estiver ligado.
- A tela é enviada separadamente para cada sala. Com muitas salas, é preciso mais internet de envio (o sistema reduz a qualidade automaticamente: cerca de 4 Mbps no total).
- O chat guarda as últimas 150 mensagens de cada sala e é apagado quando a rodada seguinte começa.



## 1) Conta no LiveKit Cloud
Crie uma conta em https://cloud.livekit.io, crie um projeto e copie **URL** (`wss://...livekit.cloud`), **API Key** e **API Secret**. O plano gratuito serve para testar; para uso regular (≈ 25–30 alunos várias vezes por semana) provavelmente será preciso um plano pago — confira os preços atuais no site.

## 2) Rodar no seu computador
```
npm install
cp .env.example .env     # preencha os valores
npm run dev
```
Abra http://localhost:3000/professor. Câmera/microfone funcionam em `localhost` ou em HTTPS.

## 3) Publicar (Render)
- Suba esta pasta para um repositório no GitHub e crie um *Web Service* no Render (ou use o `render.yaml`).
- Build: `npm install` · Start: `npm start` · variáveis: as do `.env.example`.
- **Atenção:** no plano gratuito o Render "dorme" após inatividade e o disco é apagado — as aulas criadas somem e o primeiro acesso demora. Use um plano sempre ligado nos dias de aula e, se quiser manter o histórico, um disco persistente apontando `DATA_FILE` para ele.
- O site precisa ser HTTPS (o Render já entrega).

## Variáveis
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `PROFESSOR_PASSWORD` (obrigatórias); `SESSION_SECRET`, `DATA_FILE`, `PORT`, `MAX_STUDENTS` (80), `RETENTION_DAYS` (30).

## Testes
`npm test` roda o teste do ciclo completo (28 alunos, 2 rodadas, trava, chamadas, tokens). A parte de vídeo/áudio real do LiveKit **não** é coberta: faça um teste com 2 dispositivos antes da primeira aula de verdade.

## Observações
- Cada sala de alunos é uma sala LiveKit própria; o professor só se conecta às salas em que clicou em Ver vídeo, Ouvir ou Falar, então só essas consomem minutos de participante extra no LiveKit.
- Se houver poucos alunos de um nível, o sistema usa salas de 3 para evitar repetir parceiros; se não der, mostra quantos pares repetiram.
