// Idioma da tela. A chave é o próprio texto em português; sem tradução no dicionário, fica o português.
type Lang = "pt" | "en";

function pick(): Lang {
  try {
    const saved = localStorage.getItem("toxify.lang");
    if (saved === "pt" || saved === "en") return saved;
    return navigator.language.toLowerCase().startsWith("pt") ? "pt" : "en";
  } catch {
    return "pt";
  }
}

export const LANG: Lang = pick();
export const LOCALE = LANG === "pt" ? "pt-BR" : "en-US";

/** Troca o idioma e recarrega a tela (troca é rara, não vale deixar tudo reativo). */
export function setLang(l: Lang) {
  try {
    localStorage.setItem("toxify.lang", l);
  } catch {
    /* sem localStorage: só vale até fechar */
  }
  location.reload();
}

/** "44.1" vira "44,1" em português. */
export const dec = (s: string) => (LANG === "pt" ? s.replace(".", ",") : s);

/** t("Playlist · {n} músicas", { n: 3 }) */
export function t(pt: string, vars?: Record<string, string | number>): string {
  const s = LANG === "en" ? (EN[pt] ?? pt) : pt;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

const EN: Record<string, string> = {
  // ---------------------------------------------------------------- geral
  "Voltar": "Go back",
  "Avançar": "Go forward",
  "Início": "Home",
  "O que você quer ouvir?": "What do you want to play?",
  "Buscar": "Search",
  "Playlist": "Playlist",
  "Playlists": "Playlists",
  "música": "song",
  "músicas": "songs",
  "Músicas": "Songs",
  "álbum": "album",
  "álbuns": "albums",
  "Álbum": "Album",
  "Álbuns": "Albums",
  "artista": "artist",
  "artistas": "artists",
  "Artista": "Artist",
  "Artistas": "Artists",
  "faixa": "track",
  "faixas": "tracks",
  "arquivo": "file",
  "arquivos": "files",
  "e": "and",
  "Sua biblioteca": "Your Library",
  "Criar playlist": "Create playlist",
  "Músicas Curtidas": "Liked Songs",
  "Lendo biblioteca… {done} de {total}": "Reading library… {done} of {total}",
  "Arrumar biblioteca": "Fix library",
  "Configurações": "Settings",
  "Nova playlist": "New playlist",
  "Minha playlist nº {n}": "My Playlist #{n}",
  "Criar": "Create",
  "Abrir": "Open",
  "Cancelar": "Cancel",
  "Salvar": "Save",
  "Fechar": "Close",
  "Apagar": "Delete",
  "Renomear": "Rename",
  "Desfazer": "Undo",
  "Nome": "Name",
  "Ano": "Year",
  "Título": "Title",
  "Qualidade": "Quality",
  "Duração": "Duration",
  "Gênero": "Genre",
  "Número": "Number",
  "Nº": "#",

  // ---------------------------------------------------------------- biblioteca (model)
  "Sem álbum": "No album",
  "Artista desconhecido": "Unknown artist",
  "{names} e mais": "{names} and more",
  "Mix {g}": "{g} Mix",
  "Suas mais tocadas": "Your top songs",
  "As que você mais ouviu desde sempre": "The ones you've played the most, ever",
  "Na repetição": "On repeat",
  "O que você mais ouviu no último mês": "What you played the most this past month",
  "Mix de {name}": "{name} Mix",
  "{names} e parecidos": "{names} and similar",
  "Ainda não ouviu": "Not played yet",
  "Da sua biblioteca, do jeito que você curte": "From your library, the way you like it",
  "Pra redescobrir": "Rediscover",
  "Você curtia, faz tempo que não toca": "You used to love these, haven't played them in a while",
  "Anos {d}": "{d}s",
  "Hi-Res de verdade": "True Hi-Res",
  "Só 24 bit acima de 48 kHz": "Only 24 bit above 48 kHz",
  "Juntar as grafias de \"{name}\"": "Merge the spellings of \"{name}\"",
  "O artista aparece escrito de {n} jeitos: {list}. Deixa tudo como \"{name}\".": "This artist is spelled {n} different ways: {list}. Makes them all \"{name}\".",
  "Corrigir o artista de \"{album}\"": "Fix the artist of \"{album}\"",
  "Está como \"{wrong}\", que não é artista. As faixas são de \"{artist}\".": "It says \"{wrong}\", which isn't an artist. The tracks are by \"{artist}\".",
  "O álbum está sem artista. As faixas são de \"{artist}\".": "The album has no artist. The tracks are by \"{artist}\".",
  "(vazio)": "(empty)",
  "Separar os artistas de \"{album}\"": "Split the artists of \"{album}\"",
  "O artista do álbum está como \"{wrong}\", tudo junto. Separando, o álbum aparece na página de {names}.":
    "The album artist is \"{wrong}\", all in one. Split up, the album shows on the page of {names}.",
  "Limpar o nome do álbum \"{album}\"": "Clean up the album name \"{album}\"",
  "O nome tem lixo do arquivo baixado e o número do CD. Fica \"{album}\", disco {disc}, e os CDs viram um álbum só.":
    "The name has leftovers from the download and the CD number. It becomes \"{album}\", disc {disc}, and the CDs merge into one album.",
  "O nome tem lixo do arquivo baixado. Fica só \"{album}\".": "The name has leftovers from the download. It becomes just \"{album}\".",
  "{album} (disco {disc})": "{album} (disc {disc})",

  // gêneros (só os que mudam em inglês; a chave salva continua em português)
  "Rap alternativo": "Alternative rap",
  "Rap consciente": "Conscious rap",
  "Rap Brasil": "Brazilian rap",
  "Rap consciente BR": "Conscious rap BR",
  "Funk consciente": "Conscious funk",
  "R&B alternativo": "Alternative R&B",
  "Funk e Disco": "Funk & Disco",
  "Pop latino": "Latin pop",
  "Rock alternativo": "Alternative rock",
  "Rock progressivo": "Progressive rock",
  "Psicodélico": "Psychedelic",
  "Rock nacional": "Brazilian rock",
  "Eletrônica": "Electronic",
  "Clássica": "Classical",
  "Trilha sonora": "Soundtrack",
  "Latina": "Latin",

  // ---------------------------------------------------------------- player
  "Posição da música": "Song position",
  "Boost de +{n}%: o som é amplificado e um limitador segura os picos": "+{n}% boost: the sound is amplified and a limiter catches the peaks",
  "Volume 100%: o som sai intocado": "Volume 100%: the sound goes out untouched",
  "Abaixo de 100% o volume é digital (o som é recalculado)": "Below 100% the volume is digital (the sound is recalculated)",
  "Silenciar": "Mute",
  "Tirar do mudo": "Unmute",
  "Pausado. Quando tocar, mostra aqui como o som está saindo.": "Paused. When something plays, this shows how the sound is going out.",
  "Modo compartilhado: o Windows mistura e converte o som.": "Shared mode: Windows mixes and converts the sound.",
  "Convertida de {from} pra {to} kHz pra entrar no crossfade sem pausa.": "Converted from {from} to {to} kHz so the crossfade has no gap.",
  "Velocidade ou tom alterados: o som é processado. Voltando os dois ao normal, sai intocado.":
    "Speed or pitch changed: the sound is processed. Set both back to normal and it goes out untouched.",
  "Boost de +{n}%: o som é amplificado e um limitador segura os picos. Em 100% sai intocado.":
    "+{n}% boost: the sound is amplified and a limiter catches the peaks. At 100% it goes out untouched.",
  "Volume abaixo de 100%: o som é recalculado. Em 100% sai intocado.": "Volume below 100%: the sound is recalculated. At 100% it goes out untouched.",
  "Bit-perfect: sai exatamente como está no arquivo.": "Bit-perfect: goes out exactly as it is in the file.",
  "tom": "pitch",
  "Som": "Sound",
  "Arquivo": "File",
  "Saída": "Output",
  "pausado": "paused",
  "Placa": "Device",
  "Padrão do Windows": "Windows default",
  "exclusivo": "exclusive",
  "compartilhado": "shared",
  "Mistura uma música na outra ao trocar de álbum. Álbum em ordem emenda sem pausa.": "Blends one song into the next when the album changes. An album in order plays gapless.",
  "Duração do crossfade": "Crossfade length",
  "Modo exclusivo": "Exclusive mode",
  "O Toxify fala direto com a placa, sem o Windows no meio. Outros apps ficam sem som enquanto toca.":
    "Toxify talks straight to the sound card, without Windows in between. Other apps go silent while it plays.",
  "original": "original",
  "{n} semitom": "{n} semitone",
  "{n} semitons": "{n} semitones",
  "Velocidade": "Speed",
  "Voltar ao normal": "Back to normal",
  "Tom": "Pitch",
  "Voltar ao tom original": "Back to original pitch",
  "Com velocidade ou tom mexidos o som é processado. Voltando os dois ao normal, sai intocado de novo.":
    "With speed or pitch changed the sound is processed. Set both back to normal and it goes out untouched again.",
  "Repetir": "Repeat",
  "Repetir a fila": "Repeat queue",
  "Repetir esta música": "Repeat this song",
  "Aleatório": "Shuffle",
  "Anterior": "Previous",
  "Pausar": "Pause",
  "Tocar": "Play",
  "Tocar {name}": "Play {name}",
  "Próxima": "Next",
  "Letra": "Lyrics",
  "Letras": "Lyrics",
  "Fila": "Queue",
  "Tocando": "Playing",
  "Tocando agora": "Now playing",
  "Painel Tocando agora": "Now playing panel",
  "Tela cheia": "Full screen",
  "Não deu pra tocar: {error}": "Couldn't play: {error}",
  "Instrumental, sem letra.": "Instrumental, no lyrics.",
  "Sem letra.": "No lyrics.",
  "Tradução": "Translation",
  "Ir pra esse trecho": "Jump to this part",
  "Letra: {source}": "Lyrics: {source}",
  "arquivo .lrc": ".lrc file",
  "LRCLIB": "LRCLIB",
  "instrumental": "instrumental",
  "Tradução automática": "Automatic translation",
  "Escolhe uma música pra começar.": "Pick a song to get started.",
  "entra com crossfade de {n}s": "comes in with a {n}s crossfade",
  "emendada, sem pausa": "gapless, no pause",
  "a placa troca pra {rate} kHz": "the sound card switches to {rate} kHz",
  "Fechar painel": "Close panel",
  "Procurando a letra…": "Looking for lyrics…",
  "Não achei a letra dessa.": "Couldn't find lyrics for this one.",
  "A seguir": "Up next",
  "A seguir (aleatório)": "Up next (shuffle)",
  "Abrir fila": "Open queue",
  "{albums} · {tracks} na sua biblioteca": "{albums} · {tracks} in your library",
  "Capa": "Cover",
  "Sair da tela cheia": "Exit full screen",
  "Sair da tela cheia (Esc)": "Exit full screen (Esc)",
  "Toca uma música pra ver aqui.": "Play a song to see it here.",
  "Sem informações do artista.": "No artist info.",

  // ---------------------------------------------------------------- avisos e menus
  "Arrumei {n} coisas na sua biblioteca": "Fixed {n} things in your library",
  "Arrumei 1 coisa na sua biblioteca": "Fixed 1 thing in your library",
  "Já está em \"{name}\"": "Already in \"{name}\"",
  "Adicionadas em \"{name}\"": "Added to \"{name}\"",
  "Adicionada em \"{name}\"": "Added to \"{name}\"",
  "Adicionada às Curtidas": "Added to Liked Songs",
  "Removida das Curtidas": "Removed from Liked Songs",
  "Tirar das Curtidas": "Remove from Liked Songs",
  "Curtir": "Like",
  "Tocar a seguir": "Play next",
  "Vai tocar a seguir": "Playing next",
  "Adicionar à fila": "Add to queue",
  "Adicionada à fila": "Added to queue",
  "Adicionar à playlist": "Add to playlist",
  "Ir para o álbum": "Go to album",
  "Ir para o artista": "Go to artist",
  "Mudar o gênero desta música": "Change this song's genre",
  "Mudar o gênero de {name}": "Change {name}'s genre",
  "Editar informações": "Edit details",
  "Mais opções": "More options",
  "Tirar desta playlist": "Remove from this playlist",
  "Disco {n}": "Disc {n}",
  "Álbum adicionado à fila": "Album added to queue",
  "Mostrar tudo": "Show all",

  // ---------------------------------------------------------------- início
  "Boa madrugada": "Good evening",
  "Bom dia": "Good morning",
  "Boa tarde": "Good afternoon",
  "Boa noite": "Good evening",
  "Feito pra você": "Made for you",
  "Suas playlists": "Your playlists",
  "Tocadas recentemente": "Recently played",
  "Seus artistas": "Your artists",
  "Em alta resolução": "In high resolution",
  "Adicionados por último": "Recently added",
  "Nenhuma música por aqui ainda": "No music here yet",
  "Lendo sua biblioteca: {done} de {total} arquivos…": "Reading your library: {done} of {total} files…",
  "Escolhe a pasta onde ficam suas músicas.": "Pick the folder where your music lives.",
  "Escolher pasta": "Choose folder",

  // ---------------------------------------------------------------- álbum e artista
  "Esse álbum não está mais na biblioteca.": "This album isn't in your library anymore.",
  "Tocar no aleatório": "Shuffle play",
  "Mais de {name}": "More by {name}",
  "Esse artista não está mais na biblioteca.": "This artist isn't in your library anymore.",
  "Muda em qual mix esse artista entra": "Changes which mix this artist goes into",
  "Sem gênero": "No genre",
  "Adicionar tudo à fila": "Add all to queue",
  "Mudar o gênero": "Change genre",
  "Renomear artista": "Rename artist",
  "Populares": "Popular",
  "Mostrar menos": "Show less",
  "Ver mais": "See more",
  "Discografia": "Discography",
  "Aparece em": "Appears on",
  "{name} agora entra no \"{mix}\"": "{name} now goes into \"{mix}\"",
  "{name} volta a usar o gênero do artista": "{name} goes back to the artist's genre",
  "{name} volta a usar o gênero dos arquivos": "{name} goes back to the genre in the files",
  "Gênero de {name}": "Genre of {name}",
  "Só pra essa música, vale mais que o gênero do artista. Não mexe no arquivo.": "Just for this song, it overrides the artist's genre. The file isn't touched.",
  "É o que decide em qual mix \"Feito pra você\" ele entra. Não mexe nos arquivos.": "This decides which \"Made for you\" mix they go into. The files aren't touched.",
  "Buscar ou criar: emo rap, phonk, pagodão...": "Search or create: emo rap, phonk, shoegaze...",
  "{g} (tudo de {g})": "{g} (all of {g})",
  "Outro": "Other",
  "Ex.: Boom bap, Phonk, Pagodão": "E.g. Boom bap, Phonk, Shoegaze",
  "Usar o do artista": "Use the artist's",
  "Usar o dos arquivos": "Use the files'",
  "Usar \"{name}\"": "Use \"{name}\"",

  // ---------------------------------------------------------------- listas, mixes, playlists
  "Ordenar por": "Sort by",
  "Toca no coração de uma música pra ela aparecer aqui.": "Tap the heart on a song to see it here.",
  "Montados com o que você ouve, curte e pula. Mudam todo dia e vão ficando mais a sua cara.":
    "Built from what you play, like and skip. They change every day and get more like you over time.",
  "Esse mix não existe mais (eles mudam conforme você ouve).": "This mix doesn't exist anymore (they change as you listen).",
  "Salvo como playlist \"{name}\"": "Saved as playlist \"{name}\"",
  "Salvar como playlist": "Save as playlist",
  "Essa playlist não existe mais.": "This playlist doesn't exist anymore.",
  "Playlist adicionada à fila": "Playlist added to queue",
  "Apagar playlist": "Delete playlist",
  "Tirada da playlist": "Removed from playlist",
  "Essa playlist está vazia.": "This playlist is empty.",
  "Arraste músicas até ela na lateral, ou clique com o botão direito numa música e escolha \"Adicionar à playlist\".":
    "Drag songs onto it in the sidebar, or right-click a song and choose \"Add to playlist\".",
  "Renomear playlist": "Rename playlist",
  "Apagar playlist?": "Delete playlist?",
  "A playlist \"{name}\" some do Toxify. As músicas continuam na sua biblioteca.": "The playlist \"{name}\" will be removed from Toxify. The songs stay in your library.",
  "Playlist \"{name}\" apagada": "Playlist \"{name}\" deleted",
  "Criada \"{name}\"": "Created \"{name}\"",
  "Adicionar {n} músicas": "Add {n} songs",
  "Já está aqui": "Already here",

  // ---------------------------------------------------------------- busca e fila
  "Digita o nome de uma música, álbum ou artista lá em cima.": "Type the name of a song, album or artist up top.",
  "Navegar": "Browse",
  "Nada encontrado pra \"{q}\".": "Nothing found for \"{q}\".",
  "Melhor resultado": "Top result",
  "Todas as músicas": "All songs",
  "A fila está vazia. Toca um álbum ou uma música pra começar.": "The queue is empty. Play an album or a song to get started.",
  "Reprodução automática": "Autoplay",
  "Músicas parecidas com o que você estava ouvindo": "Songs similar to what you were listening to",
  "Tirar da fila": "Remove from queue",
  "Nada depois dessa.": "Nothing after this one.",
  "Toca uma música pra ver a letra.": "Play a song to see the lyrics.",

  // ---------------------------------------------------------------- configurações
  "Idioma do Toxify": "Toxify language",
  "Muda os textos do app e o idioma da tradução das letras. A tela recarrega.": "Changes the app's text and the language lyrics are translated into. The screen reloads.",
  "Biblioteca": "Library",
  "Pastas onde o Toxify procura música. Subpastas entram também.": "Folders where Toxify looks for music. Subfolders are included.",
  "Tirar {folder}": "Remove {folder}",
  "Escolha a pasta de músicas": "Choose your music folder",
  "Adicionar pasta": "Add folder",
  "Lendo… {done} de {total}": "Reading… {done} of {total}",
  "Ler a biblioteca de novo": "Rescan library",
  "O Toxify fala direto com a placa de som e troca a taxa a cada música. É o que garante o som intocado. Enquanto toca, outros apps ficam sem som.":
    "Toxify talks straight to the sound card and switches the sample rate for each song. That's what keeps the sound untouched. While it plays, other apps go silent.",
  "Mistura uma música na outra quando muda de álbum ou está no aleatório. Álbum tocando em ordem sempre emenda sem pausa.":
    "Blends one song into the next when the album changes or on shuffle. An album playing in order is always gapless.",
  "Quando a fila ou a playlist acaba, continua tocando músicas do mesmo estilo que você curte.": "When the queue or playlist ends, keeps playing songs in the same style you like.",
  "Automático": "Automatic",
  "Arrumar a biblioteca sozinho": "Fix the library automatically",
  "Toda vez que ler suas músicas, aplica as correções do \"Arrumar biblioteca\" (artista escrito errado, lixo de site no nome, CDs separados). Avisa o que fez e dá pra desfazer.":
    "Every time it reads your music, applies the \"Fix library\" fixes (misspelled artists, website junk in names, split CDs). It tells you what it did and you can undo it.",
  "O gênero de cada artista vem das tags das músicas. Se estiver errado, troque na página do artista: os mixes passam a usar a sua escolha.":
    "Each artist's genre comes from the song tags. If it's wrong, change it on the artist page: the mixes will use your choice.",
  "Mostrar o que estou ouvindo": "Show what I'm listening to",
  "Aparece \"Ouvindo Toxify\" no seu perfil, com a música, o artista, a capa e o tempo. Some quando você pausa.":
    "Shows \"Listening to Toxify\" on your profile, with the song, artist, cover and time. Disappears when you pause.",
  "Traduzir letras pra português": "Translate lyrics to English",
  "Usa o Google Tradutor. A tradução aparece embaixo de cada linha e fica guardada no PC.": "Uses Google Translate. The translation shows under each line and is saved on your PC.",

  // ---------------------------------------------------------------- arrumar biblioteca e editor
  "Desfazer a última alteração": "Undo the last change",
  "Coisas que achei nas tags das suas músicas. Nada muda sem você mandar. Antes de gravar, cada arquivo é copiado, editado na cópia e conferido; e dá pra desfazer depois.":
    "Things I found in your music tags. Nothing changes unless you say so. Before saving, each file is copied, the copy is edited and checked, and you can undo it later.",
  "Tudo certo por aqui. Nenhuma tag torta encontrada.": "All good here. No messy tags found.",
  "Aplicar todas ({n})": "Apply all ({n})",
  "Esconder": "Hide",
  "Ver o que muda ({n})": "See what changes ({n})",
  "Ignorar": "Ignore",
  "Aplicar": "Apply",
  "Aplicar {n} correções": "Apply {n} fixes",
  "Nada pra desfazer.": "Nothing to undo.",
  "Pronto, 1 arquivo voltou como estava.": "Done, 1 file is back to how it was.",
  "Pronto, {n} arquivos voltaram como estavam.": "Done, {n} files are back to how they were.",
  "Pronto, {files}.": "Done, {files}.",
  "arquivo atualizado": "file updated",
  "arquivos atualizados": "files updated",
  "Vou gravar nas tags de {files}. A música em si não é tocada: só o nome, artista, álbum e afins.":
    "This will write to the tags of {files}. The audio itself isn't touched: only the name, artist, album and so on.",
  "Uma delas está tocando agora. Se o Windows não deixar trocar o arquivo, pausa e tenta de novo.":
    "One of them is playing right now. If Windows won't let the file be replaced, pause and try again.",
  "Gravar": "Save changes",
  "Gravando… {done} de {total}": "Saving… {done} of {total}",
  "Alguns arquivos não foram alterados (os originais ficaram intactos):": "Some files weren't changed (the originals are intact):",
  "Salvar \"{album}\"": "Save \"{album}\"",
  "Nome do álbum": "Album name",
  "Artista do álbum": "Album artist",
  "Quem aparece como dono do álbum": "Who shows up as the album's owner",
  "Artista da faixa": "Track artist",
  "Renomear pra \"{name}\"": "Rename to \"{name}\"",
  "Muda o \"artista do álbum\" em {tracks}. Se já existir um artista com esse nome, os dois viram um só (bom pra juntar \"Ye\" com \"Kanye West\").":
    "Changes the \"album artist\" on {tracks}. If an artist with that name already exists, the two become one (handy for merging \"Ye\" with \"Kanye West\").",

  // ---------------------------------------------------------------- atualização
  "Toxify {v} disponível. Baixa, instala e abre de novo sozinho; playlists e curtidas continuam.":
    "Toxify {v} is available. Downloads, installs and reopens by itself; playlists and likes stay.",
  "Não deu pra atualizar: {e}": "Couldn't update: {e}",
  "Baixando…": "Downloading…",
  "Atualizar": "Update",
};
