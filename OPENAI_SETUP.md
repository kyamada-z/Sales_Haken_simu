# OpenAI版の設定（管理者用）

GitHub Pagesは計算画面として維持します。AIは同じコードをVercelの保護されたPreviewに配置して利用します。レポートの保存先はブラウザーのlocalStorageで、GitHub PagesとVercelの保存内容は別です。

## 有効化する順序

1. VercelのGitHubアプリに、このリポジトリだけのアクセスを許可します。
2. Vercelにリポジトリを接続し、Previewとしてデプロイします。
3. Deployment ProtectionでVercel AuthenticationをAll Deploymentsに設定します。共有用バイパスリンクや公開例外は作成しません。
4. ログアウトした状態で画面と `/api/analyze` の両方がVercelの認証で遮断されることを確認します。許可するユーザーだけにVercelのアクセスを付与します。
5. `/api/analyze` に対するVercel Firewallのレート制限を設定します。最初は1 IPあたり毎分5回程度を目安にし、社内ネットワークでの利用に合わせて調整します。これは月額の厳密な上限ではありません。
6. OpenAIでこのアプリ専用のプロジェクトとAPIキーを作成し、モデルの利用制限・利用量通知を設定します。予算通知は強制停止の保証ではありません。
7. VercelのEnvironment Variablesに、下記を **Previewだけ** に登録します。キーはSensitiveにし、チャットやGitHubに貼り付けません。

| 名前 | 値 | 用途 |
|---|---|---|
| OPENAI_API_KEY | ご自身のOpenAI APIキー | サーバー専用。Sensitiveにする |
| AI_ENABLED | true | 保護確認後にのみ有効化 |
| VITE_AI_ENABLED | true | AIボタンの表示・有効化。秘密情報ではない |

8. Previewを再デプロイし、許可されたアカウントでレポート生成とチャットを確認します。

## 安全上の設計と制約

- OpenAIへの通信はサーバーの `/api/analyze` から行い、ブラウザーにAPIキーを配信しません。
- サーバーはPreview・有効化フラグ・キーのすべてがそろわないと停止します。ProductionではAIを動かしません。
- 認証はVercel Deployment Protectionが担当します。`AI_ENABLED`やOrigin検査そのものは認証ではありません。Protectionを解除する前にAIを停止し、古いデプロイも無効化してください。
- 入力容量・会話件数・出力トークン・待機時間を制限し、自動再試行はしません。
- モデルは `gpt-5-mini`。Responses APIで `store: false` を指定します。これはOpenAIでのすべてのログ保持がゼロになるという意味ではありません。
- シミュレーション数値と会話履歴をOpenAIに送信します。個人情報や顧客名は入力しない運用にしてください。
- IP制限だけで月額費用は固定できません。厳密な月間上限が必要な場合は、永続DBで全リクエストの利用枠を予約・集計する処理を追加してください。
- 停止時はAI_ENABLEDをfalseにして再デプロイし、以前のPreviewを削除・無効化します。緊急時は専用OpenAIキーを失効させてください。

## 検証

`node --test test/analyze.test.js` と `npm run build` を実行します。モックテストでは本物のAPIキーやOpenAIへの有料リクエストを使用しません。実際の認証保護・Firewall・APIキー登録後の疎通確認は別途必要です。
