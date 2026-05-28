import { mapUrlFor } from '../data/maps';
import { MapView } from './MapView';

// Dashboard shell over <MapView>: resolves the per-run map URL via the
// build-time glob in src/data/maps.ts and points at the deployed
// game-data path. The hub mounts MapView differently — each shell is
// only responsible for URL resolution.

export function RunMapPlayer({ runName }: { runName: string }) {
  const mapUrl = mapUrlFor(runName);
  if (!mapUrl) {
    return <div className="run-map-player run-map-error">no map data for {runName}</div>;
  }
  const spritesUrl = `${import.meta.env.BASE_URL}game-data/map-sprites.json`;
  return <MapView mapUrl={mapUrl} spritesUrl={spritesUrl} />;
}
