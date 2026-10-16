# Anitsu Downloader

Userscript para o [Anitsu Cloud](https://nuvem.anitsu.moe/) com seleção de arquivos, download em massa, integração com gerenciadores e capas de animes nas pastas.

**Versão recomendada: 1.6.9.** [Baixar Anitsu-1.6.9.user.js](https://github.com/LucasPreto0000/Anitsu-Downloader/releases/download/v1.6.9/Anitsu-1.6.9.user.js) · [Releases](https://github.com/LucasPreto0000/Anitsu-Downloader/releases) · [Histórico de mudanças](CHANGELOG.md)

## O que a versão atual oferece

- Downloads diretos e envio ao AB Download Manager (ABDM) ou Internet Download Manager (IDM).
- Seleção por arquivo, Todos/Nenhum, filtro por extensão e seleção em intervalo com Shift.
- Navegação automática pelas pastas e carregamento recursivo para baixar subpastas.
- Lotes no ABDM com tamanho, intervalo, fila e pasta de destino configuráveis.
- Popup de chave API quando o ABDM exige autenticação, com armazenamento pelo gerenciador de userscripts.
- Persistência e renovação da sessão existente do Anitsu.
- Detecção de nomes de anime considerando sinônimos, temporada, parte e ano; capas nas pastas via AniList e correção manual por ID.
- Cache e consultas agrupadas para carregar capas com menos chamadas.
- Painel com seleção sem reconstruir a lista inteira, arraste em pixels inteiros, console que pode ser ocultado e fundo opaco.

## Instalação

1. Instale o [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) ou outro gerenciador compatível com as APIs GM usadas no script.
2. Instale [Anitsu-1.6.9.user.js](https://github.com/LucasPreto0000/Anitsu-Downloader/releases/download/v1.6.9/Anitsu-1.6.9.user.js) no Tampermonkey. Para substituir a versão anterior, confirme a atualização ou desative/remova a cópia antiga; mantenha apenas uma ativa.
3. Abra o Anitsu Cloud, entre normalmente e navegue até uma pasta.
4. Use Carregar quando necessário, escolha os arquivos e clique em Baixar.

Mantenha apenas uma versão do Anitsu Downloader ativa para evitar painéis e operações duplicados.

## ABDM, IDM e sessão

Para usar o ABDM, abra o aplicativo e ative sua integração com navegadores. A porta padrão do painel é 15151. Se a integração exigir uma chave API, copie a chave das configurações do ABDM e informe-a no popup. Após configurada, a linha de autenticação é ocultada; uma chave recusada volta a abrir a configuração.

O uso do IDM depende do aplicativo e de sua integração estarem instalados e configurados no navegador.

O indicador de minutos informa a validade restante do token de acesso. Ele pode ser clicado para tentar renovar a sessão. A linha atual tenta manter o cookie da sessão por até 30 dias e renovar o token automaticamente; isso depende de a sessão continuar válida e de o navegador preservar seus dados.

As capas dependem dos resultados e da disponibilidade do AniList. Quando a correspondência automática falhar, use a correção manual por ID do anime. O preenchimento das capas se refere às pastas carregadas na lista, não a uma varredura automática de todo o acervo do site.

## Versões e variantes

Este repositório preserva **20 arquivos versionados**, distribuídos por **16 números de versão**, de 1.5.0 a 1.6.9. As Releases disponíveis são 1.6.8 e 1.6.9; as anteriores permanecem na pasta de histórico. Cada atualização futura deve incrementar a versão e criar sua própria Release, com um arquivo Anitsu-VERSÃO.user.js, sem substituir versões anteriores.

- [versions/](versions/) contém os arquivos históricos.
- [CHANGELOG.md](CHANGELOG.md) explica o que cada versão acrescentou e descreve as variantes.
- [versions/manifest.json](versions/manifest.json) lista versões, nomes de origem e hashes SHA-256 para conferir a integridade.
- Cada Release contém um único userscript com o número da versão no nome. A 1.6.9 contém a correção de autenticação de 16 de outubro de 2026. Na raiz, Anitsu.js, Anitsu-Downloader.user.js e Anitsu Downloader.js contêm a versão atual e são mantidos por compatibilidade.

Há arquivos com o mesmo número interno e conteúdos diferentes. As variantes sessao, abdm-legado e detector-legado identificam essas diferenças. Em 1.5.0, original e original-lf diferem apenas nas quebras de linha.

Os arquivos em versions/ foram preservados byte a byte. Seus metadados podem apontar para o endereço antigo do Greasy Fork. O Anitsu.js corrigido e as cópias na raiz usam URLs de atualização deste GitHub.

As notas foram reconstruídas pela comparação do código disponível. A publicação do acervo em 2 de outubro de 2026 não pretende estabelecer datas originais de lançamento nem afirmar que todas as versões históricas foram testadas no site atual.

## Créditos

Autores identificados nos scripts: **TheCyBee & Saitama**. Os cabeçalhos históricos indicam licença MIT. As capas e os dados de anime são consultados no AniList.
