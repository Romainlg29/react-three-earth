import type { FeatureCollection, Point } from 'geojson'

/** Name, longitude, latitude, elevation in metres, country or range. Summit positions rounded from OpenStreetMap. */
const PEAKS: Array<[string, number, number, number, string]> = [
  ['Mount Everest', 86.925, 27.9881, 8849, 'Nepal and China'],
  ['K2', 76.5133, 35.8825, 8611, 'Pakistan and China'],
  ['Kangchenjunga', 88.1475, 27.7025, 8586, 'Nepal and India'],
  ['Lhotse', 86.9336, 27.9617, 8516, 'Nepal and China'],
  ['Makalu', 87.0889, 27.8897, 8485, 'Nepal and China'],
  ['Cho Oyu', 86.6608, 28.0942, 8188, 'Nepal and China'],
  ['Dhaulagiri', 83.4931, 28.6967, 8167, 'Nepal'],
  ['Manaslu', 84.5597, 28.5494, 8163, 'Nepal'],
  ['Nanga Parbat', 74.5892, 35.2375, 8126, 'Pakistan'],
  ['Annapurna', 83.8203, 28.5961, 8091, 'Nepal'],
  ['Gasherbrum I', 76.6961, 35.7244, 8080, 'Pakistan and China'],
  ['Broad Peak', 76.5683, 35.8106, 8051, 'Pakistan and China'],
  ['Shishapangma', 85.7797, 28.3525, 8027, 'China'],
  ['Muztagh Ata', 75.1167, 38.2756, 7509, 'China'],
  ['Ismoil Somoni Peak', 72.0167, 38.9417, 7495, 'Tajikistan'],
  ['Mount Kailash', 81.3119, 31.0675, 6638, 'China'],
  ['Aconcagua', -70.0109, -32.6532, 6961, 'Argentina'],
  ['Ojos del Salado', -68.5411, -27.1092, 6893, 'Argentina and Chile'],
  ['Huascarán', -77.6044, -9.1222, 6768, 'Peru'],
  ['Chimborazo', -78.8175, -1.4692, 6263, 'Ecuador'],
  ['Cotopaxi', -78.4378, -0.6806, 5897, 'Ecuador'],
  ['Denali', -151.0074, 63.0692, 6190, 'United States'],
  ['Mount Logan', -140.4053, 60.5672, 5959, 'Canada'],
  ['Pico de Orizaba', -97.2683, 19.0303, 5636, 'Mexico'],
  ['Mount Whitney', -118.2923, 36.5785, 4421, 'United States'],
  ['Mount Elbert', -106.4453, 39.1178, 4401, 'United States'],
  ['Mount Rainier', -121.7603, 46.8529, 4392, 'United States'],
  ['Mount Robson', -119.1561, 53.1104, 3954, 'Canada'],
  ['Mauna Kea', -155.4681, 19.8206, 4207, 'United States'],
  ['Pico Duarte', -70.9997, 19.0236, 3098, 'Dominican Republic'],
  ['Kilimanjaro', 37.3556, -3.0674, 5895, 'Tanzania'],
  ['Mount Kenya', 37.3083, -0.1521, 5199, 'Kenya'],
  ['Mount Stanley', 29.8717, 0.3856, 5109, 'Uganda and DR Congo'],
  ['Mount Cameroon', 9.1708, 4.2167, 4040, 'Cameroon'],
  ['Toubkal', -7.9158, 31.0597, 4167, 'Morocco'],
  ['Mount Teide', -16.6425, 28.2724, 3715, 'Spain'],
  ['Mount Elbrus', 42.4392, 43.3499, 5642, 'Russia'],
  ['Mount Ararat', 44.2981, 39.7019, 5137, 'Türkiye'],
  ['Mount Damavand', 52.1092, 35.9553, 5610, 'Iran'],
  ['Mount Sinai', 33.975, 28.5394, 2285, 'Egypt'],
  ['Belukha', 86.5897, 49.8072, 4506, 'Russia and Kazakhstan'],
  ['Mont Blanc', 6.8652, 45.8326, 4806, 'France and Italy'],
  ['Monte Rosa', 7.8669, 45.9369, 4634, 'Switzerland and Italy'],
  ['Matterhorn', 7.6586, 45.9763, 4478, 'Switzerland and Italy'],
  ['Jungfrau', 7.9625, 46.5367, 4158, 'Switzerland'],
  ['Grossglockner', 12.6939, 47.0745, 3798, 'Austria'],
  ['Zugspitze', 10.9863, 47.4211, 2962, 'Germany'],
  ['Mount Etna', 14.9934, 37.751, 3357, 'Italy'],
  ['Mount Olympus', 22.3583, 40.0856, 2918, 'Greece'],
  ['Galdhøpiggen', 8.3125, 61.6364, 2469, 'Norway'],
  ['Ben Nevis', -5.0037, 56.7969, 1345, 'United Kingdom'],
  ['Mount Fuji', 138.7274, 35.3606, 3776, 'Japan'],
  ['Kita-dake', 138.2386, 35.6744, 3193, 'Japan'],
  ['Yari-ga-take', 137.6475, 36.3419, 3180, 'Japan'],
  ['Mount Ontake', 137.4806, 35.8928, 3067, 'Japan'],
  ['Yushan', 120.9575, 23.47, 3952, 'Taiwan'],
  ['Mount Kinabalu', 116.5583, 6.0753, 4095, 'Malaysia'],
  ['Puncak Jaya', 137.1583, -4.0833, 4884, 'Indonesia'],
  ['Aoraki / Mount Cook', 170.1418, -43.595, 3724, 'New Zealand'],
  ['Mount Kosciuszko', 148.2636, -36.4559, 2228, 'Australia'],
  ['Vinson Massif', -85.6172, -78.5254, 4892, 'Antarctica'],
  ['Mount Erebus', 167.1533, -77.5297, 3794, 'Antarctica'],
]

export interface PeakProperties {
  name: string
  elevationMeters: number
  country: string
}

/** The peaks as GeoJSON points, with numeric ids for feature-state. */
export const peaks: FeatureCollection<Point, PeakProperties> = {
  type: 'FeatureCollection',
  features: PEAKS.map(([name, longitude, latitude, elevationMeters, country], index) => ({
    type: 'Feature',
    id: index + 1,
    properties: { name, elevationMeters, country },
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
  })),
}
