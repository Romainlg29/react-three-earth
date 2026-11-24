import type { FeatureCollection, Point } from 'geojson'

/** Name, longitude, latitude, urban area population in millions (rounded, recent UN and census estimates). */
const CITIES: Array<[string, number, number, number]> = [
  ['Tokyo', 139.69, 35.69, 37.1], ['Delhi', 77.21, 28.61, 33.8], ['Shanghai', 121.47, 31.23, 29.9], ['Dhaka', 90.41, 23.81, 23.9],
  ['São Paulo', -46.63, -23.55, 22.8], ['Mexico City', -99.13, 19.43, 22.5], ['Cairo', 31.24, 30.04, 22.6], ['Beijing', 116.41, 39.9, 21.8],
  ['Mumbai', 72.88, 19.08, 21.7], ['Osaka', 135.5, 34.69, 19.0], ['Chongqing', 106.55, 29.56, 17.3], ['Karachi', 67.01, 24.86, 17.2],
  ['Kinshasa', 15.27, -4.44, 17.0], ['Lagos', 3.38, 6.52, 16.0], ['Istanbul', 28.98, 41.01, 15.8], ['Buenos Aires', -58.38, -34.6, 15.6],
  ['Kolkata', 88.36, 22.57, 15.5], ['Manila', 120.98, 14.6, 14.9], ['Guangzhou', 113.26, 23.13, 14.3], ['Tianjin', 117.2, 39.08, 14.2],
  ['Lahore', 74.36, 31.55, 13.9], ['Bangalore', 77.59, 12.97, 13.6], ['Rio de Janeiro', -43.17, -22.91, 13.7], ['Shenzhen', 114.06, 22.54, 13.1],
  ['Moscow', 37.62, 55.76, 12.7], ['Chennai', 80.27, 13.08, 12.0], ['Bogotá', -74.07, 4.71, 11.5], ['Jakarta', 106.85, -6.21, 11.4],
  ['Lima', -77.04, -12.05, 11.2], ['Paris', 2.35, 48.86, 11.2], ['Bangkok', 100.5, 13.76, 11.1], ['Hyderabad', 78.49, 17.39, 10.8],
  ['Seoul', 126.98, 37.57, 10.0], ['Nagoya', 136.91, 35.18, 9.6], ['London', -0.13, 51.51, 9.6], ['Chengdu', 104.07, 30.57, 9.5],
  ['Tehran', 51.39, 35.69, 9.5], ['Ho Chi Minh City', 106.66, 10.76, 9.3], ['Luanda', 13.23, -8.84, 9.3], ['Wuhan', 114.31, 30.59, 8.9],
  ['New York', -74.01, 40.71, 18.9], ['Los Angeles', -118.24, 34.05, 12.5], ['Chicago', -87.63, 41.88, 8.9], ['Toronto', -79.38, 43.65, 6.4],
  ['Dallas', -96.8, 32.78, 6.6], ['Houston', -95.37, 29.76, 6.4], ['Miami', -80.19, 25.76, 6.2], ['Atlanta', -84.39, 33.75, 5.1],
  ['Washington', -77.04, 38.91, 5.4], ['San Francisco', -122.42, 37.77, 6.7], ['Montreal', -73.57, 45.5, 4.3], ['Santiago', -70.65, -33.45, 6.9],
  ['Riyadh', 46.68, 24.71, 7.7], ['Baghdad', 44.36, 33.31, 7.5], ['Khartoum', 32.53, 15.5, 6.3], ['Johannesburg', 28.05, -26.2, 6.2],
  ['Nairobi', 36.82, -1.29, 5.3], ['Addis Ababa', 38.76, 9.03, 5.5], ['Dar es Salaam', 39.21, -6.79, 7.8], ['Abidjan', -4.02, 5.36, 5.7],
  ['Madrid', -3.7, 40.42, 6.8], ['Barcelona', 2.17, 41.39, 5.7], ['Milan', 9.19, 45.46, 3.2], ['Rome', 12.5, 41.9, 4.3],
  ['Berlin', 13.4, 52.52, 3.6], ['Ruhr', 7.2, 51.45, 5.1], ['Saint Petersburg', 30.34, 59.93, 5.6], ['Athens', 23.73, 37.98, 3.2],
  ['Singapore', 103.82, 1.35, 6.1], ['Kuala Lumpur', 101.69, 3.14, 8.6], ['Hong Kong', 114.17, 22.32, 7.6], ['Taipei', 121.57, 25.03, 7.0],
  ['Sydney', 151.21, -33.87, 5.3], ['Melbourne', 144.96, -37.81, 5.2], ['Auckland', 174.76, -36.85, 1.7], ['Perth', 115.86, -31.95, 2.2],
  ['Ahmedabad', 72.57, 23.02, 8.9], ['Pune', 73.86, 18.52, 7.2], ['Surat', 72.83, 21.17, 8.1], ['Yangon', 96.16, 16.87, 5.6],
  ['Hanoi', 105.83, 21.03, 5.3], ['Kabul', 69.17, 34.53, 4.6], ['Tashkent', 69.24, 41.3, 2.9], ['Almaty', 76.89, 43.24, 2.0],
]

/** The cities as GeoJSON points, weighted by `populationMillions`. */
export const cities: FeatureCollection<Point, { name: string; populationMillions: number }> = {
  type: 'FeatureCollection',
  features: CITIES.map(([name, longitude, latitude, populationMillions]) => ({
    type: 'Feature',
    properties: { name, populationMillions },
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
  })),
}
