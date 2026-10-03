# Histórico de versões

Acervo publicado em 2 de outubro de 2026. As datas locais não foram usadas como datas oficiais de lançamento. As descrições abaixo foram reconstruídas a partir da comparação dos arquivos disponíveis. Versões históricas podem conter limitações já corrigidas em versões posteriores.

A versão recomendada é **1.6.8**, a única publicada nas Releases. Variantes com o mesmo número foram preservadas com sufixos; seus números internos `@version` não foram alterados.

## 1.6.8 — recomendada

- Torna o fundo principal totalmente opaco: substitui rgba(15,18,30,0.98) por #0f121e.
- Impede que texto e elementos do site apareçam por trás do menu. É a versão recomendada da linha atual.

Arquivos:

- [Anitsu-1.6.8.user.js](versions/1.6.8/Anitsu-1.6.8.user.js) — principal

## 1.6.7

- Usa left/top em pixels inteiros durante o arraste e remove translate3d e will-change:transform desse fluxo.
- O ResizeObserver deixa de reposicionar o painel enquanto ele é arrastado, evitando a mistura entre posição visual e posição salva.
- Ajusta a restrição ao tamanho da janela e o salvamento da posição para não incorporar a transformação da animação de abertura.

Arquivos:

- [Anitsu-1.6.7.user.js](versions/1.6.7/Anitsu-1.6.7.user.js) — principal

## 1.6.6

- Só inicia o arraste após um deslocamento de 5 pixels, evitando que um clique com pequena movimentação altere a posição.
- Adia mudanças de posicionamento e de composição visual até começar um arraste real.

Arquivos:

- [Anitsu-1.6.6.user.js](versions/1.6.6/Anitsu-1.6.6.user.js) — principal

## 1.6.5

- Remove a transição de movimento depois de arrastar, evitando a animação ao soltar o painel.
- Mantém a animação de abertura do painel.

Arquivos:

- [Anitsu-1.6.5.user.js](versions/1.6.5/Anitsu-1.6.5.user.js) — principal

## 1.6.4

- Reduz desfoques, sombras e animações pesadas do painel; aplica renderização adiada às linhas fora da área visível.
- Todos, Nenhum e filtros passam a atualizar a seleção sem reconstruir a lista inteira; capas e rolagem são preservadas.
- Calcula estatísticas em uma passagem e usa mapas para localizar linhas e checkboxes.
- Corrige seleção com Shift entre arquivos e modifica o arraste para usar requestAnimationFrame. O arraste desta versão ainda usava transform e foi revisto depois.

Arquivos:

- [Anitsu-1.6.4.user.js](versions/1.6.4/Anitsu-1.6.4.user.js) — principal

## 1.6.3

- Aumenta o lote de buscas de capas para até 24 consultas com adaptação diante de falhas; reaproveita capas e grava o cache com menos frequência.
- Melhora comparação por ano para remakes, tolerância a pequenas diferenças de grafia e alternativas de consulta, incluindo Reikezan/Reikenzan.
- Evita trabalho desnecessário em pastas genéricas e reutiliza imagens ao remontar a lista.

Arquivos:

- [Anitsu-1.6.3.user.js](versions/1.6.3/Anitsu-1.6.3.user.js) — principal

## 1.6.2

- Aumenta o lote de consultas AniList para até 16 buscas e amplia o número de candidatos por busca para 15.
- Melhora variações do nome e avaliação dos resultados; cancela consultas antigas ao trocar de pasta e verifica se a visualização continua ativa.
- Ajusta o cache para v4 e o tratamento de limite de consultas.

Arquivos:

- [Anitsu-1.6.2.user.js](versions/1.6.2/Anitsu-1.6.2.user.js) — principal

## 1.6.1

- Inicia a busca de capas para todas as pastas carregadas na lista, inclusive as fora da área visível.
- Agrupa até 6 consultas AniList por chamada, usa cache v3 e inclui tentativas de recuperação e fallback para consultas individuais.

Arquivos:

- [Anitsu-1.6.1.user.js](versions/1.6.1/Anitsu-1.6.1.user.js) — principal

## 1.6.0

- Variante principal: detecção de títulos com limpeza de nomes de release, análise de temporada/parte/ano, comparação de títulos e sinônimos e escolha por confiança.
- Adiciona capas às pastas da lista, cache persistente de resultados, fila de consultas e correção manual por ID do AniList.
- Reaproveita listagens de pastas, limita o observador da navegação ao breadcrumb e ajusta a linha de autenticação do ABDM.
- Variante detector-legado: primeira revisão de busca com múltiplos candidatos, comparação de título/temporada/ano e cache em memória; anterior ao popup de chave API e às capas em todas as pastas.

Arquivos:

- [Anitsu-1.6.0-detector-legado.user.js](versions/1.6.0/Anitsu-1.6.0-detector-legado.user.js) — detector-legado
- [Anitsu-1.6.0.user.js](versions/1.6.0/Anitsu-1.6.0.user.js) — principal

## 1.5.5

- Introduz ocultação da linha de configuração após a chave API ser salva e reexibição quando ela for recusada.
- Limitação histórica confirmada no código: o id anu-abdm-auth-row foi aplicado à linha de pasta destino nesta cópia; a linha correta foi ajustada na variante principal 1.6.0. O arquivo histórico foi mantido intacto.

Arquivos:

- [Anitsu-1.5.5.user.js](versions/1.5.5/Anitsu-1.5.5.user.js) — principal

## 1.5.4

- Suporte à chave API do ABDM com popup de configuração, teste pelo endpoint /ping e armazenamento pelo gerenciador de userscripts.
- Envia X-Api-Key nas chamadas ao ABDM; trata respostas 401 e interrompe o restante do lote quando a autenticação falha.
- Identifica a necessidade de chave ao abrir a página. Ajusta downloadSource.type para http e startDownload para iniciar o download.

Arquivos:

- [Anitsu-1.5.4.user.js](versions/1.5.4/Anitsu-1.5.4.user.js) — principal

## 1.5.3

- Remove as setas nativas dos campos numéricos da configuração do ABDM, como Porta, Lote e Intervalo.
- Mantém as melhorias da variante sessao 1.5.2.

Arquivos:

- [Anitsu-1.5.3.user.js](versions/1.5.3/Anitsu-1.5.3.user.js) — principal

## 1.5.2

- Variante sessao: alinha a bolinha dos interruptores ABDM/IDM, ajusta as dicas dos gerenciadores e do console para dentro do painel e atualiza o texto da dica ao ocultar/mostrar o console.
- Variante abdm-legado: acrescenta campo de chave API, armazenamento via GM_getValue/GM_setValue, cabeçalho X-Api-Key e mensagens para respostas 401; segue a variante legada 1.5.1.

Arquivos:

- [Anitsu-1.5.2-abdm-legado.user.js](versions/1.5.2/Anitsu-1.5.2-abdm-legado.user.js) — abdm-legado
- [Anitsu-1.5.2-sessao.user.js](versions/1.5.2/Anitsu-1.5.2-sessao.user.js) — sessao

## 1.5.1

- Variante sessao: gravação persistente da sessão por até 30 dias, renovação automática e tratamento dos cookies de autenticação, carregamento inicial e troca de pasta com espera menor, tooltips da sessão posicionados dentro do painel.
- Variante abdm-legado: adiciona startDownload/startQueue ao envio para iniciar o arquivo ou a fila no ABDM. Esta variante tem conteúdo diferente da variante sessao apesar de usar o mesmo @version.

Arquivos:

- [Anitsu-1.5.1-abdm-legado.user.js](versions/1.5.1/Anitsu-1.5.1-abdm-legado.user.js) — abdm-legado
- [Anitsu-1.5.1-sessao.user.js](versions/1.5.1/Anitsu-1.5.1-sessao.user.js) — sessao

## 1.5.0

- Base original com painel flutuante, seleção e filtro de arquivos, downloads diretos, ABDM/IDM, lotes, navegação recursiva e preview de anime pelo AniList.
- O acervo inclui duas cópias cujo código é igual após normalizar as quebras de linha; ambas foram preservadas byte a byte (original e original-lf).

Arquivos:

- [Anitsu-1.5.0-original.user.js](versions/1.5.0/Anitsu-1.5.0-original.user.js) — original
- [Anitsu-1.5.0-original-lf.user.js](versions/1.5.0/Anitsu-1.5.0-original-lf.user.js) — original-lf
