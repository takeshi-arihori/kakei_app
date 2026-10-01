/**
 * 業務接続前の入口として利用目的を説明し、未提供の操作を案内しない。
 * @returns 共有割り勘の流れと利用開始前であることを示す内容。
 */
export default function Home() {
  return (
    <>
      <section className="intro" aria-labelledby="intro-title">
        <p className="eyebrow">一緒に使う、一緒に分ける。</p>
        <h1 id="intro-title">支出から精算まで、<span className="title-phrase">グループで。</span></h1>
        <p className="lead">
          立て替えた支出を記録し、みんなで内容を確認。
          誰が誰にいくら支払うかと、受け取りの確認までをひとつの流れで整理します。
        </p>
      </section>
      <ol className="journey" aria-label="共有割り勘の流れ">
        <li>
          <span className="step-number" aria-hidden="true">01</span>
          <h2>支出を記録</h2>
          <p>手入力やレシートから、グループの支出と負担割合を整理します。</p>
        </li>
        <li>
          <span className="step-number" aria-hidden="true">02</span>
          <h2>みんなで確認</h2>
          <p>精算する支出を選び、必要な参加者が金額と支払先を確認します。</p>
        </li>
        <li>
          <span className="step-number" aria-hidden="true">03</span>
          <h2>受け取りまで確認</h2>
          <p>グループ外での支払いと受け取りを記録し、完了した精算を振り返ります。</p>
        </li>
      </ol>
      <p className="scope-note">1〜4人のグループに対応。アプリ内で送金は行いません。</p>
      <p className="availability-note">利用開始の準備を進めています。</p>
    </>
  );
}
