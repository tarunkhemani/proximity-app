import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="min-h-screen bg-radar-bg flex flex-col items-center justify-center gap-6">
      <p className="text-6xl font-bold text-gradient">404</p>
      <p className="text-white/50">This frequency is off the map.</p>
      <Link to="/radar" className="btn-primary">
        Back to radar
      </Link>
    </div>
  );
}