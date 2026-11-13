import NowPlayingCard from './NowPlayingCard';

export default function NowPlayingSettings() {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h1>Now playing</h1>
          <p>
            What you are playing on Spotify, the same way Cordia shows whether you are online.
            The desktop app reads Spotify's media session from Windows and ignores everything
            else - a browser tab or a video player is never picked up. Nothing is posted to your
            profile and nothing is written into a message.
          </p>
        </div>
      </div>
      <NowPlayingCard />
    </section>
  );
}
