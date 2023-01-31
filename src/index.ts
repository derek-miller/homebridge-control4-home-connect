import { API } from 'homebridge';

import { PLATFORM_NAME } from './settings';
import { C4HCHomebridgePlatform } from './platform';

/**
 * This method registers the platform with Homebridge
 */
export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, C4HCHomebridgePlatform);
};
