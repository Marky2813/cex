import { parse } from "node:path";
import { createClient } from "redis";
import { responseClient } from "../redis"

export const QUEUE_ID = Math.random()

let pendingResolves = {}

async function pollQueue() {
  const response = await responseClient.brPop("order-response"+QUEUE_ID, 1);
  if (!response) {
    console.log(response);
    pollQueue()
  } else {
  const parsedResponse = JSON.parse(response.element);
  console.log(parsedResponse)
  if (parsedResponse.identifier && pendingResolves[parsedResponse.identifier]) {
    pendingResolves[parsedResponse.identifier]({filledQty:parsedResponse.filledQuantity})
  }
  pollQueue()
}
}

pollQueue()


export function untilWeGotBack(identifier: number) {
  return new Promise((resolve, reject) => {
    pendingResolves[identifier] = resolve;
  })
}

