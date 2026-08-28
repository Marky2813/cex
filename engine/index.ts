import { createClient } from "redis";
import { Heap } from 'heap-js';
import { string, symbol, z } from "zod/v4";
import { parse } from "dotenv";
import { ParseStatus } from "zod/v3";
import { responseClient, client } from "../redis"


while(1) {
  const response = await client.brPop("incoming-order", 1); 
  if(!response) continue; 
  console.log(response)
  const parsedResponse = JSON.parse(response.element);
  console.log(parsedResponse)
  //perform matching logic. now we need to return the identifier and the fillqty back to the backend, that should be done via another queue
  //because if you create a client using redis, for one queue it can either read data or write data and it cannot do both simulataneously
  // await responseClient.lPush("order-response"+parsedResponse.queue_id, JSON.stringify(parsedResponse.filledQty, parsedResponse.identifier)) //the response should be the identifier and the filled qty. 
  const filledQuantity = parsedResponse.amount; 
  await responseClient.lPush("order-response"+parsedResponse.queueId, JSON.stringify({filledQuantity, identifier:parsedResponse.identifier}))
  console.log("published")
}