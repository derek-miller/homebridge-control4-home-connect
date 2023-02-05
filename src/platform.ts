import {
  API,
  APIEvent,
  Characteristic,
  CharacteristicValue,
  DynamicPlatformPlugin,
  HapStatusError,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer, Server } from 'http';
import { CharacteristicProps, Perms } from 'hap-nodejs/dist/lib/Characteristic';
import { HAPStatus } from 'hap-nodejs/dist/lib/HAPServer';

type C4HCHomebridgePlatformConfig = PlatformConfig & { port: number };

type C4HCIncomingMessage =
  | {
      topic: 'set-request';
      payload: C4HCIncomingSetMessagePayload;
    }
  | {
      topic: 'get-request';
      payload: C4HCIncomingGetMessagePayload;
    }
  | {
      topic: 'add-request';
      payload: C4HCIncomingAddMessagePayload;
    }
  | {
      topic: 'remove-request';
      payload: C4HCIncomingRemoveMessagePayload;
    };

interface C4HCIncomingCommonMessagePayload {
  uuid: string;
}

type C4HCIncomingSetMessagePayload = C4HCIncomingCommonMessagePayload & {
  name: string;
  service: string;
  characteristic: string;
  value: CharacteristicValue | HapStatusError;
  identifier?: CharacteristicValue | null;
};

type C4HCIncomingGetMessagePayload = C4HCIncomingCommonMessagePayload & {
  name: string;
  service: string;
  characteristic: string;
};

/**
 * Accessory definitions
 */
type C4HCAccessoryDefinition = {
  uuid: string;
  name: string;
  category?: number;
  external?: boolean;
  services: C4HCServicesDefinition;
};

type C4HCServicesDefinition = {
  [serviceName: string]: 'default' | C4HCServiceDefinition;
};

type C4HCServiceDefinition = {
  characteristics: C4HCCharacteristicsDefinition;
  linkedServices?: Exclude<C4HCServicesDefinition, 'linkedServices'>[];
};

type C4HCCharacteristicsDefinition = {
  [name: Exclude<string, 'value' | 'props'>]:
    | 'default'
    | CharacteristicValue
    | C4HCCharacteristicDefinition;
};

type C4HCCharacteristicDefinition = {
  value?: CharacteristicValue;
  props?: CharacteristicProps;
};

interface C4HCPlatformAccessoryContext {
  definition: C4HCAccessoryDefinition;
}

type C4HCIncomingAddMessagePayload = C4HCIncomingCommonMessagePayload & C4HCAccessoryDefinition;

type C4HCIncomingRemoveMessagePayload = C4HCIncomingCommonMessagePayload;

interface C4HCOutgoingMessagePayload<T> {
  ack: boolean;
  message: string;
  response: T;
}

type C4HCOutgoingMessage =
  | {
      topic: 'response';
      payload: C4HCOutgoingMessagePayload<never>;
    }
  | {
      topic: 'add-response';
      payload: C4HCOutgoingMessagePayload<C4HCAccessoryDefinition>;
    }
  | {
      topic: 'remove-response';
      payload: C4HCOutgoingMessagePayload<C4HCIncomingRemoveMessagePayload | null>;
    }
  | {
      topic: 'get-response';
      payload: C4HCOutgoingMessagePayload<{
        [key: string]: C4HCAccessoryDefinition;
      }>;
    }
  | {
      topic: 'set-response';
      payload: C4HCOutgoingMessagePayload<C4HCIncomingSetMessagePayload>;
    }
  | {
      topic: 'get-request';
      payload: {
        uuid: string;
        name?: string;
        service: string;
        characteristic: string;
        identifier?: CharacteristicValue;
      };
    }
  | {
      topic: 'set-request';
      payload: {
        uuid: string;
        name?: string;
        service: string;
        characteristic: string;
        value: CharacteristicValue;
        identifier?: CharacteristicValue;
      };
    };

const ADAPTIVE_LIGHTING_CHARACTERISTIC_NAMES = [
  'SupportedCharacteristicValueTransitionConfiguration',
  'CharacteristicValueTransitionControl',
  'CharacteristicValueActiveTransitionCount',
];

export class C4HCHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly characteristicValueCache: Map<string, CharacteristicValue | HapStatusError> =
    new Map();

  public readonly config: C4HCHomebridgePlatformConfig;
  public readonly server: Server;
  public readonly ws: WebSocketServer;
  private wsConnection: WebSocket | null = null;

  constructor(
    public readonly log: Logger,
    public readonly platformConfig: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.config = <C4HCHomebridgePlatformConfig>this.platformConfig;
    this.server = createServer();
    this.ws = new WebSocketServer({ server: this.server });
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => this.startup());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
    this.addAccessory(accessory.context.definition);
  }

  async startup() {
    this.ws.on('connection', (ws, req) => {
      this.wsConnection = ws;
      this.wsConnection.on('message', (data) => {
        if (!data) {
          return;
        }
        this.log.debug('receive: %s', data);
        const message = JSON.parse(data.toString());
        if (!message.topic || !message.payload) {
          return;
        }
        this.send(this.onMessage(<C4HCIncomingMessage>message));
      });
      this.wsConnection.on('close', () => {
        this.log.info('client ip %s disconnected', req.socket.remoteAddress);
        this.characteristicValueCache.clear();
      });
      this.wsConnection.on('error', (e) => {
        this.log.error('error: %s', e.message);
      });
      this.log.info('client ip %s connected', req.socket.remoteAddress);
    });
    this.server.listen(this.config.port);
  }

  onMessage(message: C4HCIncomingMessage): C4HCOutgoingMessage {
    switch (message.topic) {
      case 'add-request':
        return {
          topic: 'add-response',
          payload: this.addAccessory(message.payload),
        };
      case 'remove-request':
        return {
          topic: 'remove-response',
          payload: this.removeAccessory(message.payload),
        };
      case 'get-request':
        return {
          topic: 'get-response',
          payload: this.getAccessories(message.payload),
        };
      case 'set-request':
        return {
          topic: 'set-response',
          payload: this.setValue(message.payload),
        };
      default:
        this.log.warn("Invalid message topic '%s'", message['topic']);
        return {
          topic: 'response',
          payload: {
            ack: false,
            message: `invalid message topic '${message['topic']}'`,
            response: message['payload'],
          },
        };
    }
  }

  onGet(
    accessory: PlatformAccessory,
    service: Service,
    characteristic: Characteristic,
  ): CharacteristicValue {
    // Trigger an update for the characteristic
    // this.send({
    //   topic: 'get-request',
    //   payload: {
    //     uuid: accessory.UUID,
    //     name: accessory.displayName,
    //     service: service.constructor.name,
    //     characteristic: characteristic.constructor.name,
    //   },
    // });
    let cachedValue = this.characteristicValueCache.get(
      cacheKey(accessory, service, characteristic),
    );
    if (cachedValue === null || cachedValue === undefined) {
      cachedValue = new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
      );
    }
    if (cachedValue instanceof this.api.hap.HapStatusError) {
      throw cachedValue;
    }
    return cachedValue;
  }

  onSet(
    accessory: PlatformAccessory,
    service: Service,
    characteristic: Characteristic,
    value: CharacteristicValue,
  ) {
    this.characteristicValueCache.set(cacheKey(accessory, service, characteristic), value);
    this.send({
      topic: 'set-request',
      payload: {
        uuid: accessory.UUID,
        name: accessory.displayName,
        service: service.constructor.name,
        characteristic: characteristic.constructor.name,
        identifier:
          service.characteristics.find((c) => c instanceof this.Characteristic.Identifier)?.value ??
          undefined,
        value,
      },
    });
  }

  addAccessory(
    payload: C4HCIncomingAddMessagePayload,
  ): C4HCOutgoingMessagePayload<C4HCIncomingAddMessagePayload> {
    let ack = false,
      message;
    const name = payload.name;
    const uuid = payload.uuid;
    const serviceNames = Object.keys(payload?.services ?? {});
    const unknownServiceNames = serviceNames.filter((s) => !this.Service[s]);
    if (serviceNames.length === 0) {
      message = 'accessories must contain at least 1 service';
    } else if (unknownServiceNames.length > 0) {
      message = 'unknown service(s): ' + unknownServiceNames.join(', ');
    } else {
      const existingAccessory = this.accessories.has(uuid);
      const accessory = this.accessories.get(uuid) ?? new this.api.platformAccessory(name, uuid);
      if (typeof payload.category === 'number') {
        accessory.category = payload.category;
      }

      // Update the accessory context with the definition.
      accessory.context = <C4HCPlatformAccessoryContext>{
        definition: payload,
      };

      const { error, addedServices = [] } = this.addServicesToAccessory(
        accessory,
        payload.services,
      );

      if (error) {
        message = error;
        this.accessories.delete(accessory.UUID);
        if (!payload.external && existingAccessory) {
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      } else {
        // Remove any cached services that were orphaned.
        accessory.services
          .filter(
            (service) =>
              !['AccessoryInformation', 'ProtocolInformation', 'HOOBS'].includes(
                service.constructor.name,
              ) && !addedServices.some((s) => Object.is(s, service)),
          )
          .forEach((service) => {
            this.log.info(
              'Removing orphaned service %s from %s',
              service.displayName || service.constructor.name,
              accessory.displayName || accessory.constructor.name,
            );
            accessory.removeService(service);
          });
        // Valid definition -> register or update the accessory
        ack = true;
        this.accessories.set(accessory.UUID, accessory);
        if (payload.external) {
          message = `added external accessory '${name}'`;
          // Existing external accessories require a homebridge restart
          if (!existingAccessory) {
            this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
          }
        } else if (existingAccessory) {
          message = `updated accessory '${name}'`;
          this.api.updatePlatformAccessories([accessory]);
        } else {
          message = `added accessory '${name}'`;
          this.log.info('Adding new accessory:', name);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
    }
    return {
      ack,
      message,
      response: payload,
    };
  }

  addServicesToAccessory(
    accessory: PlatformAccessory,
    servicesDefinition: C4HCServicesDefinition,
    parentService?: Service,
    addedServices?: Service[],
  ): { error?: string; addedServices?: Service[] } {
    addedServices = addedServices ?? [];
    for (const [serviceName, serviceDefinition] of Object.entries(servicesDefinition)) {
      const { characteristics: characteristicsDefinition, linkedServices = null } =
        serviceDefinition === 'default'
          ? { characteristics: <C4HCCharacteristicsDefinition>{} }
          : serviceDefinition;

      const idCharacteristic =
        (<C4HCCharacteristicDefinition>characteristicsDefinition.Identifier)?.value ??
        <'default' | CharacteristicValue>characteristicsDefinition.Identifier;
      const identifier = typeof idCharacteristic !== 'number' ? null : idCharacteristic;
      if (parentService && identifier === null) {
        return {
          error: 'linked services must contain an Identifier characteristic',
        };
      }

      const nameCharacteristic =
        (<C4HCCharacteristicDefinition>characteristicsDefinition.Name)?.value ??
        <'default' | CharacteristicValue>characteristicsDefinition.Name ??
        (<C4HCCharacteristicDefinition>characteristicsDefinition.ConfiguredName)?.value ??
        <'default' | CharacteristicValue>characteristicsDefinition.ConfiguredName;
      const displayName =
        typeof nameCharacteristic !== 'string' || nameCharacteristic === 'default'
          ? null
          : nameCharacteristic;
      if (parentService && displayName === null) {
        return {
          error: 'linked services must contain a Name or ConfiguredName characteristic',
        };
      }

      const service =
        serviceName === 'AccessoryInformation'
          ? accessory.getService(this.Service.AccessoryInformation)
          : accessory.getServiceById(
              this.Service[serviceName],
              `uuid=${accessory.UUID}|service=${serviceName}|id=${identifier ?? 'default'}`,
            ) ||
            accessory.addService(
              this.Service[serviceName],
              displayName ?? accessory.displayName,
              `uuid=${accessory.UUID}|service=${serviceName}|id=${identifier ?? 'default'}`,
            );
      if (!service) {
        return {
          error: `unable to add service ${serviceName} to '${accessory.displayName}'`,
        };
      }
      addedServices.push(service);

      // Add any missing required characteristics
      for (const requiredCharacteristic of service.characteristics) {
        const characteristicName = requiredCharacteristic.constructor.name;
        if (
          characteristicName === 'Name' ||
          characteristicsDefinition[characteristicName] !== undefined
        ) {
          continue;
        }
        characteristicsDefinition[characteristicName] = 'default';
      }
      const {
        error,
        addedCharacteristics = [],
        adaptiveLightingConfigured = false,
      } = this.addCharacteristicsToService(accessory, service, characteristicsDefinition);
      if (error) {
        return { error };
      }
      // Remove any cached characteristics that were orphaned.
      service.characteristics
        .filter(
          (characteristic) =>
            characteristic.constructor.name !== 'Name' &&
            (!adaptiveLightingConfigured ||
              !ADAPTIVE_LIGHTING_CHARACTERISTIC_NAMES.includes(characteristic.constructor.name)) &&
            !addedCharacteristics.some((c) => Object.is(c, characteristic)),
        )
        .forEach((characteristic) => {
          this.log.info(
            'Removing orphaned characteristic %s from %s',
            characteristic.displayName || characteristic.constructor.name,
            accessory.displayName || accessory.constructor.name,
          );
          service.removeCharacteristic(characteristic);
        });

      if (parentService) {
        parentService.addLinkedService(service);
      }

      if (linkedServices !== null && !Array.isArray(linkedServices)) {
        return {
          error: `invalid type for service ${serviceName} linkedServices; expected an array`,
        };
      }
      for (const linkedServicesDefinition of linkedServices ?? []) {
        this.addServicesToAccessory(accessory, linkedServicesDefinition, service, addedServices);
      }
    }
    return { addedServices };
  }

  addCharacteristicsToService(
    accessory: PlatformAccessory,
    service: Service,
    characteristics: C4HCCharacteristicsDefinition,
    addedCharacteristics?: Characteristic[],
  ): {
    error?: string;
    addedCharacteristics?: Characteristic[];
    adaptiveLightingConfigured?: boolean;
  } {
    addedCharacteristics = addedCharacteristics ?? [];
    const serviceName = service.constructor.name;
    for (const [characteristicName, characteristicPropertiesDefinition] of Object.entries(
      characteristics,
    )) {
      if (!(characteristicName in this.Characteristic)) {
        return {
          error: `unknown characteristic ${characteristicName}`,
        };
      }
      const characteristic = service.getCharacteristic(this.Characteristic[characteristicName]);
      if (!characteristic) {
        return {
          error: `unable to add characteristic ${characteristicName} to service ${serviceName}`,
        };
      }
      addedCharacteristics.push(characteristic);
      const characteristicDefinition =
        characteristicPropertiesDefinition === 'default'
          ? <C4HCCharacteristicDefinition>{}
          : characteristicPropertiesDefinition;

      const { value = null, props = null } =
        typeof characteristicDefinition === 'object' &&
        !Array.isArray(characteristicDefinition) &&
        (characteristicDefinition?.props !== undefined ||
          characteristicDefinition?.value !== undefined)
          ? characteristicDefinition
          : { value: characteristicDefinition };

      if (
        props !== null &&
        props !== undefined &&
        typeof props === 'object' &&
        !Array.isArray(props) &&
        Object.keys(props).length > 0
      ) {
        characteristic.setProps(props);
      }

      // Add set/get handlers
      if (
        serviceName !== 'AccessoryInformation' &&
        characteristicName !== 'Name' &&
        !ADAPTIVE_LIGHTING_CHARACTERISTIC_NAMES.includes(characteristicName) &&
        characteristic.props.perms.includes(Perms.PAIRED_READ)
      ) {
        characteristic.onGet(() => this.onGet(accessory, service, characteristic));
      }
      if (
        serviceName !== 'AccessoryInformation' &&
        characteristicName !== 'Name' &&
        !ADAPTIVE_LIGHTING_CHARACTERISTIC_NAMES.includes(characteristicName) &&
        characteristic.props.perms.includes(Perms.PAIRED_WRITE)
      ) {
        characteristic.onSet((value) => this.onSet(accessory, service, characteristic, value));
      }
      if (
        value !== null &&
        value !== undefined &&
        value !== 'default' &&
        (Array.isArray(value) || typeof value !== 'object')
      ) {
        this.characteristicValueCache.set(
          cacheKey(accessory, service, characteristic),
          <CharacteristicValue>value,
        );
        characteristic.updateValue(value);
      }
    }
    // Check if we can configure adaptive lighting
    let adaptiveLightingConfigured = false;
    if (
      serviceName === 'Lightbulb' &&
      service.testCharacteristic(this.Characteristic.Brightness) &&
      service.testCharacteristic(this.Characteristic.ColorTemperature)
    ) {
      adaptiveLightingConfigured = true;
      try {
        accessory.configureController(
          new this.api.hap.AdaptiveLightingController(service, {
            controllerMode: this.api.hap.AdaptiveLightingControllerMode.AUTOMATIC,
          }),
        );
      } catch (e) {
        // Already configured
      }
    }
    return { addedCharacteristics, adaptiveLightingConfigured };
  }

  removeAccessory(
    payload: C4HCIncomingRemoveMessagePayload,
  ): C4HCOutgoingMessagePayload<C4HCAccessoryDefinition | null> {
    const uuid = payload.uuid;
    const accessory = this.accessories.get(uuid);
    if (accessory) {
      this.log.info('Removing accessory:', accessory.displayName);
      if (!accessory.context?.definition?.external) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.accessories.delete(uuid);
      return {
        ack: true,
        message: `removed accessory '${accessory.displayName}'`,
        response: accessory.context.definition,
      };
    }
    return {
      ack: false,
      message: `accessory with UUID '${uuid}' not found`,
      response: null,
    };
  }

  getAccessories(
    payload: C4HCIncomingGetMessagePayload,
  ): C4HCOutgoingMessagePayload<{ [key: string]: C4HCAccessoryDefinition }> {
    const accessories = {};
    for (const accessory of this.accessories.values()) {
      if (payload.uuid === 'all' || payload.uuid === accessory.UUID) {
        accessories[accessory.UUID] = accessory.context.definition;
      }
    }
    return {
      ack: true,
      message: `fetched ${Object.keys(accessories).length} accessories`,
      response: accessories,
    };
  }

  setValue(
    payload: C4HCIncomingSetMessagePayload,
  ): C4HCOutgoingMessagePayload<C4HCIncomingSetMessagePayload> {
    const uuid = payload?.uuid;
    const accessory = uuid && this.accessories.get(uuid);
    if (!accessory) {
      return {
        ack: false,
        message: `unknown accessory with uuid '${uuid}'`,
        response: payload,
      };
    }
    const serviceType = this.Service[payload.service];
    if (serviceType === undefined) {
      return {
        ack: false,
        message: `unknown service '${payload.service}'`,
        response: payload,
      };
    }
    const characteristicType = this.Characteristic[payload.characteristic];
    if (characteristicType === undefined) {
      return {
        ack: false,
        message: `unknown characteristic '${payload.characteristic}'`,
        response: payload,
      };
    }

    const identifier = typeof payload.identifier === 'number' ? `${payload.identifier}` : 'default';
    const service = accessory.getServiceById(
      serviceType,
      `uuid=${accessory.UUID}|service=${payload.service}|id=${identifier ?? 'default'}`,
    );
    if (service === undefined) {
      return {
        ack: false,
        message: `accessory does not have service '${payload.service}'`,
        response: payload,
      };
    }

    const characteristic = service.getCharacteristic(characteristicType);
    if (characteristic === undefined) {
      return {
        ack: false,
        message: `accessory service ${payload.service} does not have characteristic '${payload.characteristic}'`,
        response: payload,
      };
    }

    let value = payload.value;
    if (value === null || value === undefined) {
      return {
        ack: false,
        message: 'value cannot be null or undefined',
        response: payload,
      };
    }

    if (typeof value === 'number' && isOfTypeHAPStatus(value)) {
      value = new this.api.hap.HapStatusError(value);
    }

    this.characteristicValueCache.set(cacheKey(accessory, service, characteristic), value);
    characteristic.updateValue(value);

    return {
      ack: true,
      message: `set '${accessory.displayName}' ${payload.service}.${payload.characteristic} -> ${value}`,
      response: payload,
    };
  }

  send(message: C4HCOutgoingMessage) {
    if (this.wsConnection && this.wsConnection.OPEN) {
      this.log.debug('send: %s', JSON.stringify(message, null, 2));
      this.wsConnection.send(JSON.stringify(message), (error) => {
        if (error) {
          this.log.error('send error; %s', error);
        }
      });
    }
  }
}

function cacheKey(
  accessory: PlatformAccessory,
  service: Service,
  characteristic: Characteristic,
): string {
  return `${accessory.UUID}:${service.UUID}|${service.subtype ?? ''}:${characteristic.UUID}`;
}

function isOfTypeHAPStatus(status: number): status is HAPStatus {
  return (
    status === HAPStatus.INSUFFICIENT_PRIVILEGES ||
    status === HAPStatus.SERVICE_COMMUNICATION_FAILURE ||
    status === HAPStatus.RESOURCE_BUSY ||
    status === HAPStatus.READ_ONLY_CHARACTERISTIC ||
    status === HAPStatus.WRITE_ONLY_CHARACTERISTIC ||
    status === HAPStatus.NOTIFICATION_NOT_SUPPORTED ||
    status === HAPStatus.OUT_OF_RESOURCE ||
    status === HAPStatus.OPERATION_TIMED_OUT ||
    status === HAPStatus.RESOURCE_DOES_NOT_EXIST ||
    status === HAPStatus.INVALID_VALUE_IN_REQUEST ||
    status === HAPStatus.INSUFFICIENT_AUTHORIZATION ||
    status === HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE
  );
}
