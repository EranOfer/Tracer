import { EventModel, Direction, metadata } from './model/event-model';
import { Injectable } from '@angular/core';
interface Dictionary<T> {
  [Key: string]: T;
}


const getRequestDestination = (event: EventModel) => {
  if (event.spanId) {
    return `${event.direction}_${event.spanId}_${event.metadata.count}`;
  } else { // To support broken event
    return `${event.from.name && event.from.name.toLowerCase()}->${event.to && event.to.name && event.to.name.toLowerCase()
      }:.${event.direction}_${event.spanId}_${event.metadata.count}`;
  }
};

const getRequestOppositeDestination = (event: EventModel) => {
  const direction = event.direction === Direction.RequestTwoWay ? Direction.ResponseTwoWay : Direction.RequestTwoWay;

  if (event.spanId) {
    return `${direction}_${event.spanId}_${event.metadata.count}`;
  } else { // To support broken event
    return `${event.to && event.to.name && event.to.name.toLowerCase()
      }->${event.from.name && event.from.name.toLowerCase()}:.${direction}_${event.spanId}_${event.metadata.count}`;
  }
};

@Injectable({
  providedIn: 'root'
})


export class OrderManagerService {
  constructor() { }

  GetRemoteCall(events: EventModel[]): Dictionary<EventModel> {
    const dictionary: Dictionary<EventModel> = {};

    // ignore the user metadata
    events.forEach(element => {
      delete element['metadata'];
    });

    let count: number = 1;
    events.forEach(x => {
      x.metadata = { startedAtMs: new Date(x.startedAt).getTime() } as metadata;
    });


    events = events.sort((a, b) => a.metadata.startedAtMs - b.metadata.startedAtMs);
    const requests: EventModel[] = events.filter((event) => (event.from && event.from.name) && event.to
    ) as EventModel[];

    requests.forEach(request => {
      let id: string = getRequestDestination(request);

      // support duplicate event
      if (dictionary[id]) {
        request.metadata.count = count++;
        id = getRequestDestination(request);
      }

      dictionary[id] = request;
    });

    requests.filter(x => x.direction === Direction.RequestTwoWay || x.direction === Direction.ResponseTwoWay).forEach(request => {
      const id: string = getRequestOppositeDestination(request);
      let clientRequest: EventModel = dictionary[id];
      if (!clientRequest) {
        clientRequest = {
          direction: request.direction === Direction.RequestTwoWay ? Direction.ResponseTwoWay : Direction.RequestTwoWay,
          spanId: request.spanId,
          parentSpanId: request.parentSpanId,
          from: request.to,
          to: request.from,
          action: request.action,
          startedAt: request.startedAt,
          metadata: {
            startedAtMs: request.metadata.startedAtMs,
            count: request.metadata.count,
            isFake: true,
          }
        } as EventModel;
        dictionary[id] = clientRequest;
      }
    });


    return dictionary;
  }

  SortRemoteCall(events: Dictionary<EventModel>): EventModel[] {
    const flowSeen: any = {};

    const requestToOtherSystems: EventModel[] = Object.keys(events).map(x => events[x])
      .filter(event => event.direction === Direction.RequestTwoWay
        || event.direction === Direction.RequestOneWay
        || event.direction === Direction.ResponseOneWay);

    // add all parent flows to ordered flow so we can initiate the processing

    let output: EventModel[] = [];
    let hasMissingFlows: Boolean = true;
    const visitRoots: EventModel[] = [];
    //  More Root can be added later if not connected to the root span chain
    const roots = requestToOtherSystems.filter(event => !event.parentSpanId)
      .sort((a, b) => b.metadata.startedAtMs - a.metadata.startedAtMs);

    while (hasMissingFlows) {
      if (roots.length !== 0) {
        const root = roots.pop();
        visitRoots.push(root);
        const result = this.sortByFlowHierarchy(root, events, flowSeen, requestToOtherSystems);
        output = output.concat(result);
      } else {
        // when your log is events that not order by Hierarchy we need to do best effort to extract them
        const missingEvent = requestToOtherSystems.
          filter(event => !flowSeen[event.spanId] && visitRoots.findIndex(x => x === event) === -1)
          .sort((a, b) => a.metadata.startedAtMs - b.metadata.startedAtMs);
        if (missingEvent && missingEvent.length > 0) {
          roots.push(missingEvent[0]);
        } else {
          hasMissingFlows = false;
        }
      }
    }
    return output;
  }

  // sort the events according to flow hierarchy
  sortByFlowHierarchy(root: EventModel, events: Dictionary<EventModel>, flowSeen: any, requestToOtherSystems: EventModel[]) {
    const output: EventModel[] = [];
    const orderedFlows: EventModel[] = [];
    orderedFlows.push(root);
    while (orderedFlows.length > 0) {
      const flow: EventModel = orderedFlows.pop();
      output.push(flow);
      // check if this flow has a closing event
      if (flow.direction !== Direction.ResponseTwoWay) {
        const closeEventId: string = getRequestOppositeDestination(flow);
        const closeEvent = events[closeEventId];
        if (closeEvent) {
          orderedFlows.push(closeEvent);
        }
        // get all child flow
        const uniqueFlow = flow.spanId && !(flowSeen[flow.spanId]);
        if (uniqueFlow) {
          const childFlows = requestToOtherSystems.filter(event => event.parentSpanId === flow.spanId);
          if (childFlows) {
            // order is opposite of stack
            childFlows.sort((a, b) => b.metadata.startedAtMs - a.metadata.startedAtMs).forEach((child: EventModel) => {
              orderedFlows.push(child);
            });
          }
        }
        flowSeen[flow.spanId] = 1;
      }
    }

    // missing all event the not seen
    return output;
  }

}
