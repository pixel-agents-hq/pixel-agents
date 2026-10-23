# Pixel Agents com Kiro CLI

Este projeto adapta o escritório do Pixel Agents para acompanhar agentes do Kiro CLI. Os personagens representam atividades reais de agentes iniciados pelo escritório; o terminal integrado continua sendo o lugar para conversar com o Kiro e aprovar ações.

## Iniciar no Windows

Requisitos: Node.js 20 ou superior, npm e Kiro CLI instalado. Na pasta do repositório, execute:

```powershell
npm ci
npm run build
npm run start:kiro
```

O último comando equivale a:

```powershell
node dist/cli.js --provider kiro --port 3100
```

Depois do primeiro build, você também pode abrir `INICIAR-KIRO.cmd`. Ele inicia o servidor em primeiro plano e mantém o terminal disponível para mensagens de erro. Para encerrar, use `Ctrl+C`.

Abra o link completo que o CLI imprimir. Ele inclui o token de acesso necessário para operar o escritório. Abrir apenas `http://localhost:3100` pode resultar em um escritório somente para leitura. Mantenha o link com token privado.

## Encontrar e autenticar o Kiro

No Windows, o instalador nativo normalmente coloca o executável em `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`. O provider também procura no PATH e em `~/.local/bin`.

A versão verificada com `--version` foi `kiro-cli-chat 2.33.1`. O PATH persistido do usuário já continha essa pasta, mas terminais abertos antes da instalação podiam usar um PATH antigo. Reabrir o terminal permite atualizar esse ambiente.

O provider procura o executável disponível no host. Para indicar um caminho específico antes de iniciar o escritório:

```powershell
$env:PIXEL_AGENTS_KIRO_EXECUTABLE = Join-Path $env:LOCALAPPDATA 'Kiro-Cli\kiro-cli.exe'
npm run start:kiro
```

Se for necessário autenticar, faça isso diretamente no CLI:

```powershell
& (Join-Path $env:LOCALAPPDATA 'Kiro-Cli\kiro-cli.exe') login
```

O escritório usa o chat interativo do Kiro e seu login normal. Não exige uma chave de API para o modo headless. As credenciais ficam sob responsabilidade do Kiro; não as cole no escritório nem em arquivos do projeto. O suporte nativo a Windows 11/PowerShell está descrito na [instalação oficial](https://kiro.dev/docs/getting-started/installation/).

Abrir o escritório não envia uma missão a um modelo. Ao iniciar um agente e enviar uma mensagem no terminal, o trabalho usa os modelos e os limites da sua conta Kiro. O modo normal mostra apenas eventos observados. A prévia de desenvolvimento `?showcase=1` é identificada como DEMO e simula atividades sem iniciar o Kiro.

## Autorizar os hooks

Na primeira execução, aprove pelo próprio aplicativo a instalação dos hooks do provider Kiro. O consentimento permite criar um perfil global dedicado:

```text
~/.kiro/agents/pixel-agents-office.json
~/.pixel-agents/hooks/kiro-hook.js
```

No Windows, `~` corresponde à sua pasta de usuário. O instalador preserva os perfis existentes, incluindo os do KiroCrew, e não substitui um arquivo dedicado que não reconheça como seu. A opção de hooks em Settings permite remover a integração instalada pelo escritório.

O perfil conecta eventos de início de sessão, envio de mensagem, uso de ferramentas e fim de turno ao servidor local. Ele não fixa um modelo nem acrescenta permissões automáticas. As ações do Kiro continuam sujeitas à política da conta, do projeto e às suas aprovações no terminal. Esta integração não usa `--trust-all-tools` nem oferece um atalho para ignorar essas aprovações.

O formato do perfil e dos hooks segue a [referência de custom agents](https://kiro.dev/docs/custom-agents/configuration-reference/) e a [documentação oficial de hooks](https://kiro.dev/docs/hooks/).

## Usar o escritório

Inicie um agente pelo controle de lançamento do escritório e converse com ele no terminal integrado. O provider inicia o equivalente a `kiro-cli chat --v3 --agent pixel-agents-office`, com as permissões normais do Kiro. Se o executável ou o perfil estiverem indisponíveis, corrija a indicação exibida no terminal.

Os hooks informam atividade de ferramentas e conclusão de turnos. Sem um evento suficiente, o escritório não pode garantir que distingue uma resposta final de uma pergunta ao usuário, nem mostrar uma solicitação de permissão com precisão. Consulte o terminal para essas decisões. Uma pausa na saída não é prova de bloqueio.

O provider gera um UUID local em `PIXEL_AGENTS_KIRO_SESSION_ID` para ligar os hooks ao agente iniciado pelo escritório. Esse identificador é um alias de roteamento do Pixel Agents, não um ID de sessão imposto ao Kiro e não uma lista de colegas ou sub-agentes. Sessões externas que não usam esse perfil não enviam hooks, e esta integração não varre seus históricos. Uma sessão externa iniciada manualmente com o perfil dedicado pode ser adotada quando seu diretório é acompanhado pelo escritório. Não há leitura das credenciais ou varredura dos históricos privados do Kiro.

O suporte do Kiro a [sub-agents](https://kiro.dev/docs/chat/subagents/) não implica que todos os seus estados e relações sejam visíveis nos hooks. Esta versão acompanha os agentes explicitamente iniciados no escritório e a atividade disponível; não desenha uma equipe delegada apenas porque ela foi mencionada num prompt.

Em Settings, **Enhanced Office Animations** controla as animações adicionais do escritório. Os personagens usam as animações de atividade já presentes no Pixel Agents, enquanto o editor permite personalizar móveis, pisos e disposição das mesas.

## Separar equipes e escolher modelos

No editor de layout, crie áreas para **SuperDesenvolvedores Juniores**, **Plenos**, **Seniores**, **DevOps**, **Projetos** e sua mesa de **Head Master**. Organize as mesas e associe os diretórios às áreas conforme o trabalho. Áreas, nomes e lugares organizam o escritório; não criam, por si só, hierarquia ou delegação automática entre agentes.

Use `/model` dentro do terminal do Kiro para escolher entre os modelos que sua conta disponibiliza. Modelos rápidos podem atender tarefas pequenas dos juniores; equilibrados, implementações de plenos; avançados, decisões e revisões de seniores. O perfil do escritório deixa essa escolha com você. A disponibilidade depende da conta e pode mudar; consulte a [referência de modelos](https://kiro.dev/docs/models/).

Para uma equipe automatizada, será necessário configurar e validar os papéis, limites e delegações no próprio Kiro. Um junior pode receber uma tarefa delimitada e revisão obrigatória; deploy e decisões de arquitetura devem ficar explicitamente atribuídos aos responsáveis. O escritório mostra evidências da execução e não estabelece essas responsabilidades sozinho.

## Primeira abertura do Kiro V3

Na primeira abertura, o Kiro pode perguntar se deve atualizar todos os seus perfis V2. Para preservar perfis existentes do KiroCrew, escolha **Not now — I’ll do it later**; o perfil dedicado do escritório já foi validado para esta integração.

A tela **Trust this workspace?** pede sua decisão sobre o diretório aberto. Confira que é o repositório desejado antes de escolher **Trust, continue**. Essa decisão permite que o Kiro use as configurações do projeto e leia, edite e execute arquivos ali; o painel não responde essa confirmação por você. Nenhum prompt é enviado automaticamente ao abrir uma sessão.
