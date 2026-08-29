<h1 align="center">
  <a href="https://github.com/pixel-agents-hq/pixel-agents/discussions">
    <img src="webview-ui/public/banner.png" alt="Pixel Agents">
  </a>
</h1>

<h2 align="center">エージェントを動かす、いちばん遊び心のある方法</h2>

<div align="center">

[![version](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fpablodelucca%2F3cd28398fa4a2c0a636e1d51d41aee39%2Fraw%2Fversion.json)](https://github.com/pixel-agents-hq/pixel-agents/releases)
[![marketplaces](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fpablodelucca%2F3cd28398fa4a2c0a636e1d51d41aee39%2Fraw%2Finstalls.json)](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents)
[![npm downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fpablodelucca%2F3cd28398fa4a2c0a636e1d51d41aee39%2Fraw%2Fnpm-downloads.json)](https://www.npmjs.com/package/pixel-agents)
[![stars](https://img.shields.io/github/stars/pixel-agents-hq/pixel-agents?logo=github&color=0183ff&style=flat)](https://github.com/pixel-agents-hq/pixel-agents/stargazers)
[![license](https://img.shields.io/github/license/pixel-agents-hq/pixel-agents?color=0183ff&style=flat)](https://github.com/pixel-agents-hq/pixel-agents/blob/main/LICENSE)
[![discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white&style=flat)](https://discord.gg/Yk7jXebv9H)

</div>

<div align="center">
<a href="https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents">🛒 VS Code Marketplace</a> • <a href="https://open-vsx.org/extension/pablodelucca/pixel-agents">🛒 Open VSX</a> • <a href="https://www.npmjs.com/package/pixel-agents">📦 npm</a> • <a href="https://discord.gg/Yk7jXebv9H">👾 Discord</a> • <a href="https://github.com/pixel-agents-hq/pixel-agents/discussions">💬 Discussions</a> • <a href="CONTRIBUTING.md">🤝 Contributing</a> • <a href="CHANGELOG.md">📋 Changelog</a>
</div>

<br/>

Pixel Agents は、ターミナルで動いている AI コーディングエージェントを、小さなオフィスで働くピクセルアートのキャラクターにします。デスクまで歩いて座り、ファイルを編集しているときはタイピングし、検索しているときは読み、入力待ちで止まっているときは見た目で知らせます。

同じソースツリーから、次の 2 つの形で配布しています。

- **VS Code extension** — [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) と [Open VSX](https://open-vsx.org/extension/pablodelucca/pixel-agents)。Agent は VS Code のターミナルに起動し、キャラクターはパネル領域に描画されます。
- **Standalone CLI** — `npx pixel-agents` がローカルサーバーを起動し、同じオフィスをブラウザアプリとして配信します。tmux、リモート、VS Code 以外のワークフロー向けです。

アーキテクチャは Agent にもエディタにも依存しません。型付きの `HookProvider` インターフェースが統合境界なので、新しい AI ツールの追加は 1 つのサブディレクトリで済みます。いまの参照実装は Claude Code です。Codex、Gemini、Cursor などはロードマップにあります。

![Pixel Agents screenshot](webview-ui/public/office.png)

## Features

- **1 Agent、1 キャラクター** — Claude Code のターミナルごとに、専用のアニメーションキャラクターが付きます
- **ライブな活動トラッキング** — 書き込み、読み取り、コマンド実行など、Agent が実際にしていることに合わせてキャラクターが動きます
- **Office layout editor** — 床、壁、家具を、組み込みエディタでデザインできます
- **Speech bubbles** — 入力待ちや権限待ちのとき、見た目で知らせます
- **Sound notifications** — ターン終了や権限リクエスト時に、任意でチャイムを鳴らせます
- **Sub-agents と Agent Teams** — 短命な Sub-agent と、残る Claude の Teammate を別キャラクターとして見られます。チームの役割やライフサイクルの変化も含まれます
- **レイアウトの永続化** — オフィスのデザインは保存され、VS Code のウィンドウ間で共有されます
- **共有レイアウトとアセット** — レイアウトの import/export と、外部のキャラクター・pet・家具パックの読み込み
- **Areas** — オフィスに名前付きエリアを塗り、workspace フォルダを割り当てると、新しい Agent はそのフォルダに対応する Area の席に座ります
- **多様なキャラクター** — 6 体。元になったすばらしい作品は [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) です。

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Where This Is Going

ビジョンは「ゲームを遊びながら、プロダクトを作る」です。そこから目標は 2 つあります。たくさんの Agent を動かし、指揮するための馴染みやすく直感的なインターフェースを作ること。そして、それに使う時間を管理作業ではなく遊びに近づけることです。

おおまかに 3 つの段階があります。

1. **どこでも、何とでも。** いまは VS Code かブラウザの Claude Code です。使う Agent が何であれ、働く場所がどこであれ動くべきです。新しい CLI は書き換えではなくサブディレクトリです。いまいちばん助けが欲しいところです。
2. **ほんとうのゲームに。** rate limit やトークン予算のヘルスバー。気になる指標のスコア。何かが起きる家具。プロジェクトごとにセーブファイルのように開けるオフィス。
3. **オーケストレーションの前線を広げる。** Orchestrator キャラクター。囲んでチームを作る。Agent 同士で仕事を渡す。ボードを指差して、自分でタスクを取らせる。

ほとんどはまだこれから先です。開いているものは [Issues](https://github.com/pixel-agents-hq/pixel-agents/issues) と [Discussions](https://github.com/pixel-agents-hq/pixel-agents/discussions) を、参加方法は [CONTRIBUTING.md](CONTRIBUTING.md) を見てください。

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) がインストールされ、設定済みであること
- **VS Code extension:** VS Code 1.105.0 以降
- **Standalone CLI:** Node.js 20 以降
- Windows、Linux、または macOS

## Getting Started

### VS Code extension

1. [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) または [Open VSX](https://open-vsx.org/extension/pablodelucca/pixel-agents) から Pixel Agents をインストールします。
2. ターミナルの横にある **Pixel Agents** パネルを開きます。
3. **+ Agent** をクリックして Claude Code を起動します。multi-root workspace では、先にフォルダを選んでください。

Claude を `--dangerously-skip-permissions` で使うには、**+ Agent** にホバーして **Skip permissions mode** ボタンを探してください。セキュリティ上の意味を理解したときだけ使ってください。

Pixel Agents は、extension の外で始めた Claude セッションも検出します。他の workspace のセッションも含めるには **Settings → Watch All Sessions** をオンにします。

### Standalone CLI

見たい Claude セッションがある workspace から Pixel Agents を実行します。

```bash
cd /path/to/your/project
npx pixel-agents
```

CLI は空いているローカルポートを選び、URL を表示します。Standalone は Claude を代わりに起動しません。同じ workspace で、ターミナルから Claude Code を起動してください。コマンドをグローバルに入れる場合は次です。

```bash
npm install --global pixel-agents
pixel-agents
```

必要ならアドレスやポートを固定できます。

```bash
pixel-agents --port 3100
pixel-agents --host 127.0.0.1 --port 3100
pixel-agents --help
```

デフォルトの bind アドレスは `127.0.0.1` です。`0.0.0.0` に bind すると、UI と WebSocket がローカルネットワークに公開されます。信頼できるネットワークでのみ行ってください。

CLI が表示する URL を開いてください。このセッション用の `?token=` が付いています。トークンなしでも、どのブラウザからでもオフィスを眺められます。ただし hooks のインストールや削除（`~/.claude/settings.json` のような、Agent ツール自身の設定ファイルを編集する操作）は、トークンを持つセッションにだけ提示されます。ネットワーク上のトークンなしクライアントが承認することはできません。素のアドレスを開くと、Settings の hooks トグルは拒否され、動いたように見せず実際のインストール状態を報告します。

その URL は秘密として扱ってください。token は bearer の権限であり、ローカルにいることの証明ではありません。持っている人は、サーバーに届く場所ならどこからでも hook のインストールを承認できます。共有チャンネルに URL を貼らないでください。ブラウザ履歴と、サーバー自身のリクエストログ（マスクなし）にも残ります。

`--no-terminal` を付けると、埋め込みターミナルを無効にできます。ブラウザから起動や接続をせず、Agent を眺めるだけにできます。

### extension と standalone を同時に動かす

extension と Standalone CLI は同時に動かせます。各サーバーは `~/.pixel-agents/servers/` に登録され、hook スクリプトは有効な登録すべてにイベントを送ります。VS Code と standalone は Agent、席、設定を別々に持ち、オフィスのレイアウトは共有します。

Standalone サーバーは **Ctrl+C** で止めます。自分の登録だけが削除されます。

## Customizing the Office

**Layout** をクリックしてオフィスを編集します。

- 床のパターンと壁を塗り、色とコントラストを調整できます。
- 家具の配置、回転、再着色、選択、削除。
- 自動タイルのカーペットを塗り、メイン色とアクセント色をカスタマイズできます。
- アニメーションする pet を追加し、オフィス内の pet をクリックして触れられます。
- 名前付き **Areas** を作り、タイルを塗り、workspace フォルダを割り当てます。
- 変更の undo/redo のあと、レイアウト全体を JSON として import または export できます。

現在のグリッドの外側にあるゴースト枠をクリックすると、レイアウトは最大 64×64 タイルまで広げられます。

### Office assets

同梱の家具、床、壁、カーペット、キャラクター、pet は `webview-ui/public/assets/` にあります。家具の manifest はスプライト、回転グループ、状態グループ、アニメーションフレームを記述します。

外部のキャラクター、pet、家具を読み込むには **Settings → Add Asset Directory** を使います。家具ディレクトリの構造と manifest の詳細は [docs/external-assets.md](docs/external-assets.md) を見てください。家具 manifest の作成には `scripts/asset-manager.html` のビジュアルアセットマネージャが使えます。

## How It Works

Pixel Agents は Claude Code の検出経路を 2 つ使います。

- **Hooks mode**（デフォルト） — hook スクリプトが `SessionStart`、`PreToolUse`、`PermissionRequest`、`Stop` などの Claude イベントを受け取ります。稼働中の Pixel Agents サーバーを見つけ、認証済みイベントをそれぞれに送ります。
- **Heuristic mode**（フォールバック） — hooks が使えないとき、ランタイムは `~/.claude/projects/` 以下の Claude の JSONL セッショントランスクリプトを走査して Agent の状態を推定します。hooks mode でも、イベントに含まれない詳細のためにトランスクリプトを読みます。

Claude の provider は両方のソースを共有の `AgentEvent` モデルに正規化します。`AgentRuntime` が中央の state store を更新し、アクティブな transport が型付きメッセージを React webview に送ります。オフィスは Canvas 2D で描画され、経路探索とキャラクターのステートマシンが動きます。

Pixel Agents は Claude Code 自体を改変しません。hook の設定は `~/.claude/`、永続データは `~/.pixel-agents/` に置きます。

### Architecture

- **`core/`** — provider、adapter、transport、schema、AsyncAPI のメッセージ契約。ランタイムの副作用はありません。
- **`server/`** — 共有の Fastify サーバー、agent runtime、永続化、Claude provider、トランスクリプト走査、Standalone CLI。
- **`adapters/vscode/`** — VS Code adapter。ターミナル、永続化、webview ブリッジ。
- **`webview-ui/`** — React 19、Vite、Canvas 2D、VS Code とブラウザ WebSocket クライアント向けの adapter 別 transport。

extension と CLI は esbuild でバンドルし、webview は Vite でビルドします。ユニットテストは Vitest と Node のテストランナー、E2E は Playwright で VS Code と standalone を対象にします。

## Development

```bash
git clone https://github.com/pixel-agents-hq/pixel-agents.git
cd pixel-agents
npm install
npm run build
```

VS Code で **F5** を押すと Extension Development Host が起動します。ソースからビルドした standalone バンドルを動かすには次です。

```bash
node dist/cli.js
```

よく使うチェック:

```bash
npm run check-types
npm run lint
npm test
npm run e2e
```

開発の流れは [CONTRIBUTING.md](CONTRIBUTING.md)、E2E スイートは [e2e/README.md](e2e/README.md) を見てください。

### Hosted Test Reports

ローカルで結合した Allure レポートを作り、Vercel 用にステージします。

```bash
npm run test
npm run e2e
npm run e2e -- --attach-videos-on-success
npm run vercel:prepare
```

Vercel 出力の準備なしで結合レポートだけ作るときは `npm run test:report`、ローカルで配信するときは `npm run test:report:open` です。

ステージした出力は、結合した `e2e`、`server`、`webview` の Allure レポートを `/reports/allure/` で配信します。standalone の webview プレビューは含みません。GitHub Actions は、`main` 向けの同一リポジトリ pull request に対してだけ Vercel Preview を作ります。デプロイジョブは `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID` の secrets を必要とし、fork の pull request はスキップします。

## Troubleshooting

- **Standalone が起動しない:** Node.js 20 以上を確認し、空きポートを選ぶなら `--port` を外すか、別の固定ポートを指定してください。
- **Agent が見えない:** **Settings → Instant Detection (Hooks)** がオンであることと、セッションが今の workspace に属していることを確認してください。必要なら **Watch All Sessions** を有効にします。
- **UI が切れているように見える:** **Settings → Debug View** を開き、サーバー接続、トランスクリプトパス、最新の Agent データを確認してください。
- **extension と standalone が両方動いている:** これは想定どおりです。現行バージョンは `~/.pixel-agents/servers/` に別ファイルを作ります。片方を止めても、もう片方は消えません。

## Community & Contributing

[Discord](https://discord.gg/Yk7jXebv9H) で他のユーザーと話したり、開発の様子を追ったりできます。バグ報告や機能要望は [Issues](https://github.com/pixel-agents-hq/pixel-agents/issues)、質問やアイデアは [Discussions](https://github.com/pixel-agents-hq/pixel-agents/discussions) を使ってください。

pull request を出す前に [CONTRIBUTING.md](CONTRIBUTING.md) を、参加する前に [Code of Conduct](CODE_OF_CONDUCT.md) を読んでください。

## Supporting the Project

<a href="https://github.com/sponsors/pablodelucca">
  <img src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github" alt="GitHub Sponsors">
</a>
<a href="https://ko-fi.com/pablodelucca">
  <img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi" alt="Ko-fi">
</a>

## Star History

<a href="https://www.star-history.com/?repos=pixel-agents-hq%2Fpixel-agents&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&theme=dark&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
 </picture>
</a>

## License

Pixel Agents は [MIT License](LICENSE) で利用できます。
