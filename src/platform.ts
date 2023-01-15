import {
  API,
  APIEvent,
  Characteristic,
  CharacteristicValue,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer, Server } from 'http';
import { CharacteristicProps, Perms } from 'hap-nodejs/dist/lib/Characteristic';

type C4ProxyHomebridgePlatformConfig = PlatformConfig & { port: number };

type C4ProxyIncomingMessage =
  | {
      topic: 'set-request';
      payload: C4ProxyIncomingSetMessagePayload;
    }
  | {
      topic: 'get-request';
      payload: C4ProxyIncomingGetMessagePayload;
    }
  | {
      topic: 'add-request';
      payload: C4ProxyIncomingAddMessagePayload;
    }
  | {
      topic: 'remove-request';
      payload: C4ProxyIncomingRemoveMessagePayload;
    };

interface C4ProxyIncomingCommonMessagePayload {
  uuid: string;
}

type C4ProxyIncomingSetMessagePayload = C4ProxyIncomingCommonMessagePayload & {
  name: string;
  service: string;
  characteristic: string;
  value: CharacteristicValue;
  identifier?: CharacteristicValue | null;
};

type C4ProxyIncomingGetMessagePayload = C4ProxyIncomingCommonMessagePayload & {
  name: string;
  service: string;
  characteristic: string;
};

/**
 * Accessory definitions
 */
type C4ProxyAccessoryDefinition = {
  uuid: string;
  name: string;
  category?: number;
  external?: boolean;
  services: C4ProxyServicesDefinition;
};

type C4ProxyServicesDefinition = {
  [serviceName: string]: 'default' | C4ProxyServiceDefinition;
};

type C4ProxyServiceDefinition = {
  characteristics: C4ProxyCharacteristicsDefinition;
  linkedServices?: Exclude<C4ProxyServicesDefinition, 'linkedServices'>[];
};

type C4ProxyCharacteristicsDefinition = {
  [name: Exclude<string, 'value' | 'props'>]:
    | 'default'
    | CharacteristicValue
    | C4ProxyCharacteristicDefinition;
};

type C4ProxyCharacteristicDefinition = {
  value?: CharacteristicValue;
  props?: CharacteristicProps;
};

interface C4ProxyPlatformAccessoryContext {
  definition: C4ProxyAccessoryDefinition;
}

type C4ProxyIncomingAddMessagePayload = C4ProxyIncomingCommonMessagePayload &
  C4ProxyAccessoryDefinition;

type C4ProxyIncomingRemoveMessagePayload = C4ProxyIncomingCommonMessagePayload;

interface C4ProxyOutgoingMessagePayload<T> {
  ack: boolean;
  message: string;
  response: T;
}

type C4ProxyOutgoingMessage =
  | {
      topic: 'response';
      payload: C4ProxyOutgoingMessagePayload<never>;
    }
  | {
      topic: 'add-response';
      payload: C4ProxyOutgoingMessagePayload<C4ProxyAccessoryDefinition>;
    }
  | {
      topic: 'remove-response';
      payload: C4ProxyOutgoingMessagePayload<C4ProxyIncomingRemoveMessagePayload | null>;
    }
  | {
      topic: 'get-response';
      payload: C4ProxyOutgoingMessagePayload<{
        [key: string]: C4ProxyAccessoryDefinition;
      }>;
    }
  | {
      topic: 'set-response';
      payload: C4ProxyOutgoingMessagePayload<C4ProxyIncomingSetMessagePayload>;
    }
  | {
      topic: 'get-request';
      payload: {
        uuid: string;
        name?: string;
        service: string;
        characteristic: string;
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
        identifier?: CharacteristicValue | null;
      };
    };

export class C4ProxyHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly characteristicValueCache: Map<string, CharacteristicValue> = new Map();
  public readonly config: C4ProxyHomebridgePlatformConfig;
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
    this.config = <C4ProxyHomebridgePlatformConfig>this.platformConfig;
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
        this.send(this.onMessage(<C4ProxyIncomingMessage>message));
      });
      this.wsConnection.on('close', () => {
        this.log.info('client ip %s disconnected', req.socket.remoteAddress);
      });
      this.wsConnection.on('error', (e) => {
        this.log.error('error: %s', e.message);
      });
      this.log.info('client ip %s connected', req.socket.remoteAddress);
    });
    this.server.listen(this.config.port);
  }

  onMessage(message: C4ProxyIncomingMessage): C4ProxyOutgoingMessage {
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

  onGet(accessory: PlatformAccessory, service: Service, characteristic: Characteristic) {
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
    const cachedValue = this.characteristicValueCache.get(
      cacheKey(accessory, service, characteristic),
    );
    if (cachedValue !== null && cachedValue !== undefined) {
      return cachedValue;
    }
    throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
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
        identifier: service.characteristics.find((c) => c instanceof this.Characteristic.Identifier)
          ?.value,
        value,
      },
    });
  }

  addAccessory(
    payload: C4ProxyIncomingAddMessagePayload,
  ): C4ProxyOutgoingMessagePayload<C4ProxyIncomingAddMessagePayload> {
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
      accessory.context = <C4ProxyPlatformAccessoryContext>{
        definition: payload,
      };

      const errorMessage = this.addServicesToAccessory(accessory, payload.services);
      if (errorMessage) {
        message = errorMessage;
        this.accessories.delete(accessory.UUID);
        if (!payload.external && existingAccessory) {
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      } else {
        // Valid definition -> register or update the accessory
        ack = true;
        this.accessories.set(accessory.UUID, accessory);
        if (payload.external) {
          message = `added external accessory '${name}'`;
          this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
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
    servicesDefinition: C4ProxyServicesDefinition,
    parentService: Service | null = null,
  ): string | null {
    for (const [serviceName, serviceDefinition] of Object.entries(servicesDefinition)) {
      const { characteristics: characteristicsDefinition, linkedServices = null } =
        serviceDefinition === 'default'
          ? { characteristics: <C4ProxyCharacteristicsDefinition>{} }
          : serviceDefinition;

      const idCharacteristic =
        (<C4ProxyCharacteristicDefinition>characteristicsDefinition.Identifier)?.value ??
        <'default' | CharacteristicValue>characteristicsDefinition.Identifier;
      const identifier = typeof idCharacteristic !== 'number' ? null : idCharacteristic;
      if (parentService && identifier === null) {
        return 'linked services must contain an Identifier characteristic';
      }

      const nameCharacteristic =
        (<C4ProxyCharacteristicDefinition>characteristicsDefinition.Name)?.value ??
        <'default' | CharacteristicValue>characteristicsDefinition.Name ??
        (<C4ProxyCharacteristicDefinition>characteristicsDefinition.ConfiguredName)?.value ??
        <'default' | CharacteristicValue>characteristicsDefinition.ConfiguredName;
      const displayName =
        typeof nameCharacteristic !== 'string' || nameCharacteristic === 'default'
          ? null
          : nameCharacteristic;
      if (parentService && displayName === null) {
        return 'linked services must contain a Name or ConfiguredName characteristic';
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
      if (service === undefined) {
        return `unable to add service ${serviceName} to '${accessory.displayName}'`;
      }
      if (parentService) {
        parentService.addLinkedService(service);
      }

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

      const error = this.addCharacteristicsToService(accessory, service, characteristicsDefinition);
      if (error) {
        return error;
      }

      if (linkedServices !== null && !Array.isArray(linkedServices)) {
        return `invalid type for service ${serviceName} linkedServices; expected an array`;
      }
      for (const linkedServicesDefinition of linkedServices ?? []) {
        this.addServicesToAccessory(accessory, linkedServicesDefinition, service);
      }
    }
    return null;
  }

  addCharacteristicsToService(
    accessory: PlatformAccessory,
    service: Service,
    characteristics: C4ProxyCharacteristicsDefinition,
  ): string | null {
    const serviceName = service.constructor.name;
    for (const [characteristicName, characteristicPropertiesDefinition] of Object.entries(
      characteristics,
    )) {
      if (!(characteristicName in this.Characteristic)) {
        return `unable to add characteristic ${characteristicName} to service ${serviceName}`;
      }
      const characteristic = service.getCharacteristic(this.Characteristic[characteristicName]);

      const characteristicDefinition =
        characteristicPropertiesDefinition === 'default'
          ? <C4ProxyCharacteristicDefinition>{}
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
        characteristic.props.perms.includes(Perms.PAIRED_READ)
      ) {
        characteristic.onGet(() => this.onGet(accessory, service, characteristic));
      }
      if (
        serviceName !== 'AccessoryInformation' &&
        characteristicName !== 'Name' &&
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
    return null;
  }

  removeAccessory(
    payload: C4ProxyIncomingRemoveMessagePayload,
  ): C4ProxyOutgoingMessagePayload<C4ProxyAccessoryDefinition | null> {
    const uuid = payload.uuid;
    const accessory = this.accessories.get(uuid);
    if (accessory) {
      this.log.debug("removing accessory '%s'", accessory.displayName);
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
    payload: C4ProxyIncomingGetMessagePayload,
  ): C4ProxyOutgoingMessagePayload<{ [key: string]: C4ProxyAccessoryDefinition }> {
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
    payload: C4ProxyIncomingSetMessagePayload,
  ): C4ProxyOutgoingMessagePayload<C4ProxyIncomingSetMessagePayload> {
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

    const value = payload.value;
    if (value === null || value === undefined) {
      return {
        ack: false,
        message: 'value cannot be null or undefined',
        response: payload,
      };
    }

    this.characteristicValueCache.set(cacheKey(accessory, service, characteristic), value);
    characteristic.updateValue(value);

    return {
      ack: true,
      message: `set '${accessory.displayName}' ${payload.service}.${payload.characteristic} -> ${value}`,
      response: payload,
    };
  }

  send(message: C4ProxyOutgoingMessage) {
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
  return `${accessory.UUID}:${service.UUID}:${characteristic.UUID}`;
}
