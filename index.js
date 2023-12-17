const functions = require("firebase-functions");
const admin = require("firebase-admin");
const dialogflow = require('@google-cloud/dialogflow');
const sessionClient = new dialogflow.SessionsClient();

admin.initializeApp();
const DIALOGFLOW_PROJECT_ID = "laundryfirebasebackend";

const accountSid = "****"
const authToken = "******"
const twilioNumber = "+12345678";
const agentNumber =  "+87654321";



const twilioClient = require("twilio")(accountSid, authToken);

// Convert date to a readable format like "Fri, Sept 22"
function formatDateToReadable(date) {
    const options = { weekday: 'short', month: 'short', day: 'numeric' };
    return new Date(date).toLocaleDateString(undefined, options);
}

// Fetch the available pickup days from Firestore
async function fetchAvailablePickupDays() {
    const db = admin.firestore();
    const docRef = db.collection('AvailableTime').doc('1G131OEdGLBqobPVkTt0'); 
    const doc = await docRef.get();

    if (!doc.exists) {
        console.log('No such document!');
        return [];
    }

    const daysArray = doc.data().Days;
    if (!daysArray || !Array.isArray(daysArray)) {
        console.log("The 'Days' field is either missing or not an array");
        return [];
    }

    return daysArray.map(day => getFullDayName(day));
}

// Convert abbreviated day name to full day name
function getFullDayName(abbreviatedDay) {
    const dayMap = {
        'Sun': 'Sunday',
        'Mon': 'Monday',
        'Tue': 'Tuesday',
        'Wed': 'Wednesday',
        'Thu': 'Thursday',
        'Fri': 'Friday',
        'Sat': 'Saturday'
    };

    return dayMap[abbreviatedDay] || abbreviatedDay;
}

function getDayNameFromInteger(dayInt) {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return days[dayInt];
}

// Fetch order by phone number from Firestore
async function fetchOrderByPhoneNumber(phoneNumber) {
    const db = admin.firestore();
    const ordersRef = db.collection('orders');
    const snapshot = await ordersRef.where('number', '==', phoneNumber).get();

    if (snapshot.empty) {
        console.log('No order found for the provided phone number.');
        return null;
    } 

    const doc = snapshot.docs[0];
    return {
        id: doc.id,
        data: doc.data()
    };
}

// Update order date in Firestore
async function updateOrderDate(orderId, field, newDate) {
    if (!['pickup_date', 'deliveryDate'].includes(field)) {
        console.error('Invalid field name provided for update.');
        return;
    }

    const db = admin.firestore();
    const orderRef = db.collection('orders').doc(orderId);

    const formattedDate = `${newDate.getFullYear()}-${String(newDate.getMonth() + 1).padStart(2, '0')}-${String(newDate.getDate()).padStart(2, '0')}`;

    await orderRef.update({ [field]: formattedDate });
    console.log(`Successfully updated ${field} to ${formattedDate} for order ${orderId}`);
}


async function sendAgentNotification(userOrder, incomingNumber, incomingMessage) {
    try {
        let bodyText;
        let responseMessage;
        if (userOrder) {

            bodyText = `Customer at ${userOrder.data.number} needs assistance https://flex.twilio.com/agent-desktop/\nName: ${userOrder.data.name}\nmessage = ${incomingMessage}.`;
              responseMessage = `Hello ${userOrder.data.name}, a Live agent will reach back to you soon 😊`;
        } else {
            bodyText = `Customer at ${incomingNumber} needs assistance https://flex.twilio.com/agent-desktop/\n\nmessage = ${incomingMessage}.`;
              responseMessage = `Hello, a Live agent will reach back to you soon 😊`;
        }

        await twilioClient.messages.create({
            body: bodyText,
            from: twilioNumber,
            to: agentNumber
        });
        console.log('Notification sent to agent.');
       return responseMessage;
    } catch (error) {
        console.error('Failed to notify agent:', error.message);
    }
}

async function canRescheduleForToday(desiredDate) {
    const today = new Date();

    // Check if desiredDate is today
    const isToday = desiredDate.toDateString() === today.toDateString();
    if (!isToday) {
        return true;  // If it's not today, no need to check further.
    }

    const db = admin.firestore();
    const timeSlotDoc = await db.collection('AvailableTime').doc('TmwK1UygAPqEgUYpC5mm').get();
    const timeSlots = timeSlotDoc.data().TimeSlot;

    const lastSlot = timeSlots[timeSlots.length - 1];
    const [startTime] = lastSlot.split(" - ");  // Extract start time "6:00 PM" from "6:00 PM - 9:00 PM"

    const rescheduleLimit = new Date(today);
    const [hour, minutePart] = startTime.split(":");
    const minute = minutePart.split(" ")[0];
    const period = minutePart.split(" ")[1];

    rescheduleLimit.setHours(period === 'PM' ? parseInt(hour) + 12 : parseInt(hour));
    rescheduleLimit.setMinutes(parseInt(minute));
    rescheduleLimit.setSeconds(0);
    rescheduleLimit.setMilliseconds(0);

    // Subtract 1 hour
    rescheduleLimit.setHours(rescheduleLimit.getHours() - 1);

    return today <= rescheduleLimit;
}




exports.twilioWebhook = functions.https.onRequest(async (request, response) => {
    try {
        console.log("Received request from Twilio");

        const incomingMessage = request.body.Body;
        const incomingNumber = request.body.From;
        const userOrder = await fetchOrderByPhoneNumber(incomingNumber);
        let dialogflowResponses;
        let dialogflowResponse;
        
        console.log(`Incoming message: ${incomingMessage} from number: ${incomingNumber}`);
        const sessionPath = sessionClient.projectAgentSessionPath('laundryfirebasebackend', incomingNumber); 
        const dialogflowRequest = {
            session: sessionPath,
            queryInput: {
                text: {
                    text: incomingMessage,
                    languageCode: "en-US",
                },
            },
        };


        console.log("Sending message to Dialogflow for intent detection.");

        

          try {
            dialogflowResponses = await sessionClient.detectIntent(dialogflowRequest);
        } catch (error) {
            console.error("Error during Dialogflow intent detection:", error);
            // Handle the error accordingly, e.g., send a default response and exit the function
             dialogflowResponse =  await sendAgentNotification(userOrder,incomingNumber,incomingMessage);
            response.set("Content-Type", "text/xml");
            response.send(`<Response><Message>${dialogflowResponse}</Message></Response>`);
            return; // Exit the function
        }



        const intentName = dialogflowResponses[0].queryResult.intent.displayName;
        console.log(`Detected intent: ${intentName}`);

        dialogflowResponse = dialogflowResponses[0].queryResult.fulfillmentText;

           if(intentName.endsWith("FAQ")){
            dialogflowResponse = await handleFAQIntent(intentName);
        }
        else if(intentName === 'HelpIntent'){
         dialogflowResponse = await sendAgentNotification(userOrder,incomingNumber,incomingMessage);

        }
        else if (!userOrder) {
            dialogflowResponse = handleNoOrder();
        } 
        else if (intentName === "Reschedule") {
             const parameters = dialogflowResponses[0].queryResult.parameters;
             const desiredDate = parameters && parameters.fields && parameters.fields.date && parameters.fields.date.stringValue 
            ? new Date(parameters.fields.date.stringValue) 
            : null;
             console.log("desired date:", desiredDate);
             const availableDays = await fetchAvailablePickupDays(); // Fetch the available days

           dialogflowResponse = await handleRescheduling(userOrder, desiredDate, availableDays);
            //...handle reschedule
        } 


        



        

        console.log(`Sending response: ${dialogflowResponse}`);
        response.set("Content-Type", "text/xml");
        response.send(`<Response><Message>${dialogflowResponse}</Message></Response>`);

    } catch (error) {
        console.error("Error processing the request:", error);
        response.status(500).send(`Internal Server Error: ${error.message}`);
    }
});

function isDatePresentOrFuture(dialogflowDate) {
    const inputDate = new Date(dialogflowDate);
    const today = new Date();

    // Check if it's the next year but today's month is not December or the input date's month is not January or February
    if (inputDate.getFullYear() - today.getFullYear() === 1) {
        if (!(today.getMonth() === 11 && (inputDate.getMonth() === 0 || inputDate.getMonth() === 1))) {
            inputDate.setFullYear(today.getFullYear());
        }
    }

    // Set the hours, minutes, seconds, and milliseconds to 0 to compare just the calendar date
    inputDate.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);

    return inputDate >= today;
}

function handleNoOrder() {
    console.log("No user order found for the provided number.");
    return "It looks like you don't have an active order. Please place an order at https://914washandfold.com";
}

async function handleRescheduling(userOrder, desiredDate, availableDays) {
    const orderStatus = userOrder.data.order_status;
    console.log(`Order status: ${orderStatus}`);

    let type; // Variable to store the type of reschedule (pickup or delivery)
    if (['ready for delivery', 'missed delivery', 'out for delivery'].includes(orderStatus)) {
        type = 'delivery';
    } else if (['pending pickup', 'missed pickup', 'picking up'].includes(orderStatus)) {
        type = 'pickup';
    } else {
        return handleInvalidOrderStatus();
    }
    return setRescheduleResponse(desiredDate, availableDays, type, userOrder);
}

async function setRescheduleResponse(desiredDate, availableDays, type, userOrder) {
    const formattedDesiredDate = formatDateToReadable(desiredDate);
    const dateList = availableDays.join("\n");

    if (!desiredDate) {
        return `Please provide a date for rescheduling. Here are the available days: \n${dateList}\nReply with your preferred ${type} day.`;
    } else if (!isDatePresentOrFuture(desiredDate)) {
        return `Sorry, the date ${formattedDesiredDate} is in the past. Please provide a future date for rescheduling.`;
    } else if (!await canRescheduleForToday(desiredDate)) {
        return `Sorry, it's too late to reschedule for today. Please select another date.`;
    } else if (availableDays.includes(getDayNameFromInteger(desiredDate.getDay()))) {
        await updateRescheduleDate(userOrder.id, type, desiredDate);
        return `Your rescheduling ${type} date has been set for ${formattedDesiredDate}.`;
    } else {
        return `Sorry, we can't reschedule for ${formattedDesiredDate}. However, here are the available days: \n${dateList}\nPlease reply with your preferred ${type} day.`;
    }
}

async function updateRescheduleDate(orderId, type, newDate) {
    const db = admin.firestore();
    const orderRef = db.collection('orders').doc(orderId);

    // Determine which field to update based on the type
    let fieldToUpdate = '';
    let order_statusfield = '';
    if (type === 'pickup') {
        fieldToUpdate = 'pickup_date';
        order_statusfield = 'pending pickup'
    } else if (type === 'delivery') {
        fieldToUpdate = 'deliveryDate';
        order_statusfield = 'ready for delivery'
    } else {
        console.error("Invalid type provided for update.");
        return;
    }

    
    const formattedDate = `${newDate.getFullYear()}-${String(newDate.getMonth() + 1).padStart(2, '0')}-${String(newDate.getDate()).padStart(2, '0')}`;

     try {
    await orderRef.update({
        [fieldToUpdate]: formattedDate,
        'order_status': order_statusfield
    });
    console.log(`Successfully updated order status and ${fieldToUpdate} for order ${orderId}`);
} catch (error) {
    console.error("Error updating the document:", error);
}
}

function handleInvalidOrderStatus() {
    console.log("Order status does not allow rescheduling.");
    return "Sorry, I couldn't determine what you'd like to reschedule based on your current order status.";
}



async function handleFAQIntent(intentName) {
    const faqDoc = await admin.firestore().collection('faqResponses').doc(intentName).get();
    
    let responseText = "";
    
    if (faqDoc.exists) {
        responseText = faqDoc.data().response;
        
        // if (intentName === 'PricingInfoFAQ') {
        //     if (responseText.includes("{price_per_pound}")) {
        //         const pricePerPound = await fetchPricePerPound(); // Assume a function that fetches price per pound
        //         responseText = responseText.replace("{price_per_pound}", pricePerPound);
        //     }
            
        //     if (responseText.includes("{comforter_bedding_price}")) {
        //         const comforterBeddingPrice = await fetchComforterBeddingPrice(); // Assume a function that fetches comforter bedding price
        //         responseText = responseText.replace("{comforter_bedding_price}", comforterBeddingPrice);
        //     }
        // }
        
    } else {
        console.warn(`No FAQ found in Firestore for intent: ${intentName}`);
        responseText = "I'm sorry, I couldn't find information on that.";
    }

    //responseText += "\n\nFor further assistance or to speak with a team member, reply 'HELP'.";

    return responseText;
}