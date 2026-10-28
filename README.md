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

## Novidades desta versão

- **Temas sugeridos**: lidos do Firebase (`temaEscolhido1` e `temaEscolhido2`) e mostrados acima do jogo e no painel do professor. A leitura é feita pelo servidor (variável opcional `FIREBASE_DB_URL`). As regras do Realtime Database precisam permitir leitura pública desses dois campos.
- **Permitir alunos**: botão no painel do professor (depois que a aula começa). Ligado, alunos atrasados entram em "Sem sala" até você colocá-los em uma sala.
- **Tutorial em vídeo** na sala de espera da 1ª rodada (celular e computador), com "não ver novamente".
- **Saída instantânea**: fechar a página ou clicar em Sair marca o aluno offline na hora no painel.
- Em computador, a sala ao vivo do aluno mostra vídeos à esquerda e botões + chat à direita, sem rolagem. No celular nada mudou.

## Versão de 28/10: sala de espera, encerramento, tradutor e relatório

- **Dois professores ao mesmo tempo**: cada professor entra no LiveKit com uma identidade própria. Antes os dois usavam a mesma e o LiveKit derrubava um deles a cada segundo (o áudio ficava cortando).
- **Sala de espera interativa**: quem está sem sala (antes da aula, no intervalo, no encerramento ou atrasado) se vê em quadrados, pode ligar microfone e câmera e conversa por chat. No painel, o card "Sala de espera" tem Entrar, Ver vídeo, Ouvir, Falar, Câmera e Chat. O chat funciona sem entrar. Quem entra na sala de espera consome minutos do LiveKit (todos os alunos esperando contam como participantes conectados).
- **Câmera em várias salas**: no painel "Transmissão do professor" há o grupo Câmera (todas as salas ou só as marcadas). A câmera é capturada uma vez e enviada a cada sala.
- **Encerramento**: ao terminar a rodada 2, todos voltam para a sala de espera e a aula termina sozinha em 5 minutos (`CLOSING_MINUTES`, padrão 5). O professor pode encerrar antes pelo botão "Encerrar a aula". A mensagem final com link continua sendo exibida no fim.
- **Alerta dos últimos 30 segundos**: em toda contagem regressiva (rodada e encerramento), aluno e professor veem uma faixa vermelha no topo com os segundos, borda piscando e o relógio pulsando.
- **Tradutor**: aba ao lado do chat, na sala. Português ⇄ inglês, com **Enviar no chat** (a mensagem chega à sala com um ícone 🔊 que toca a pronúncia) e Ouvir (voz do próprio navegador) no lado em inglês. A aba pisca até o aluno abri-la. Usa o serviço gratuito de tradução do Google e, se ele falhar, o MyMemory.
- **Relatório**: nasce quando a 1ª rodada começa e se atualiza sozinho até o fim. Mostra alunos que entraram, quem participou, níveis, horários de início e fim de cada rodada e da aula, e problemas de conexão (quedas, travamentos, falhas de vídeo, reinícios do servidor). Link: `/relatorio/CÓDIGO-DA-AULA` (qualquer pessoa com o link vê; o código é impossível de adivinhar). A lista de todos os relatórios fica em `/relatorios` (pede login do professor).

### Para o relatório não se perder quando você sobe atualizações

Sem disco persistente, o Render apaga os arquivos a cada deploy. Para guardar os relatórios para sempre, use o Firebase que você já tem:

1. Firebase Console → engrenagem ao lado de "Visão geral do projeto" → **Configurações do projeto** → aba **Contas de serviço** → **Gerar nova chave privada**. Baixa um arquivo `.json`.
2. No Render → seu serviço → **Environment** → **Add Environment Variable**: nome `FIREBASE_SERVICE_ACCOUNT`, valor = o conteúdo inteiro do arquivo `.json`.
3. Salve (o Render reinicia). Abra `/healthz` no seu site: deve mostrar `"relatorios":"firebase"`. Em `/relatorios` some o aviso amarelo.

Os relatórios ficam no nó `relatoriosSalas` do mesmo Realtime Database. A chave de serviço dá acesso administrativo ao projeto: guarde-a só no Render, nunca no GitHub. Alternativa: disco persistente do Render (plano pago) com `REPORTS_FILE=/var/data/reports.json`.


## Versão de 28/10 (2): Dinâmicas por sala
- Terceira aba ao lado de Chat e Tradutor (pisca até ser aberta e de novo quando alguém da sala muda a dinâmica).
- Fluxo: nome + explicação → **Sortear outra** / **Iniciar** → conteúdo. **Brincar novamente** troca o conteúdo mantendo o jogo. Tudo é sincronizado no servidor: qualquer pessoa da sala que clicar muda para todos da sala.
- Jogos: Impostor (cada um vê só o seu papel), Mímica (palavra privada + cronômetro de 30 s igual para todos), Leilão Maluco, História em Conjunto e Quem sou eu? (você vê os outros, não a si mesmo). **Ver tradução** aparece quando há inglês e some depois de usado.
- Conteúdo: `lib/dinamicas.json`. O campo `"niveis": ["intermediario"]` (na dinâmica ou em cada item) limita aquele conteúdo a salas só de intermediário; sem o campo vale para todos. Reinicie o servidor depois de editar. Para criar um jogo novo é preciso um dos 5 tipos (`impostor`, `mimica`, `leilao`, `historia`, `quemsou`).
- Também: câmeras aparecem inteiras (sem corte), menos espaço no topo, scroll da página não trava mais no chat e a voz do "Ouvir" é aquecida na sala de espera.

## Versão de 28/10 (3): ajustes de tela e Atividades
- Sua própria câmera aparece espelhada (como espelho); os outros te veem normalmente.
- Computador: a sala de espera fica como as salas (câmeras à esquerda; chat e jogo à direita). Celular não mudou.
- Contagem dos 30 s finais: sem faixa; borda piscando, número vermelho pulsando e 3 bipes ao entrar nessa fase (o som só toca depois que a pessoa tocou na tela uma vez).
- Botões Microfone/Câmera com interruptor (aceso e à direita = ligado).
- Sala de espera: câmeras se redimensionam para caber todos no mesmo espaço, sem rolagem; chat com botão Esconder; temas menores.
- Aba **Atividades** com **Dinâmicas** e **Perguntas**. Perguntas vêm de `lib/perguntas.json` (228, nenhuma de sim/não), a mesma para toda a sala, com "Sortear outra pergunta" e "Ver tradução".

## Versão de 28/10 (4)
- Topo bem mais fino; temas à direita acima do chat no computador; botão único Chamar/Cancelar chamado (pulsa enquanto chamando); microfone e câmera seguem o estado que o aluno tinha ao trocar de sala; encerramento só com a contagem.

## Versão de 28/10 (5): novo visual
- Só aparência, em `public/tema.css` (cores da logo, botões de apertar, fonte Nunito, animações leves, logo em `public/logo.png` no rodapé). Para voltar ao visual antigo, remova o link de tema.css das páginas.
