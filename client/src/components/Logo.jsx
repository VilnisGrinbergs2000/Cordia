export default function Logo({ size = 36, withText = false, stacked = false }) {
  return (
    <div className={`logo ${stacked ? 'logo-stacked' : ''}`}>
      <img
        className="logo-mark"
        src="/codi-mark.png"
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable="false"
      />
      {withText && <span className="logo-word">cordia</span>}
    </div>
  );
}
