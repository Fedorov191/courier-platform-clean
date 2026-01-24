import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";

import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";
import { useLocation } from "react-router-dom";
import { auth, db } from "./firebase";

export type Lang = "en" | "ru" | "he";
export type Dir = "ltr" | "rtl";

const STORAGE_KEY = "app_lang";

/**
 * ✅ ВАЖНО
 * Тип Key = ключи из dict.en.
 * Поэтому если добавляешь новый ключ — добавь его ВО ВСЕ 3 языка.
 */
const dict = {
    en: {
        courierConsoleTitle: "Courier Console",
        courierConsoleSubtitle: "Your work dashboard — offers, active orders, delivery steps.",

        courierOnline: "ONLINE",
        courierOffline: "OFFLINE",
        courierGoOnline: "Go online",
        courierGoOffline: "Go offline",

        courierActiveTab: "Active",
        courierCompletedTab: "Completed",

        courierActiveOrderTitle: "Active order",
        courierNewOffersTitle: "New offers",
        courierNoNewOffers: "No new offers",
        courierActiveCountLabel: "Active",
        courierMaxActiveReached: "Max active orders reached:",
        courierPresenceHint: "Presence updates while the app is open.",

        courierOrderLabel: "Order",
        courierCustomerLabel: "Customer",
        courierPhoneLabel: "Phone",
        courierAddressLabel: "Address",
        courierToRestaurantLabel: "To restaurant",
        courierPickupToDropoffLabel: "Pickup → dropoff",
        courierTotalTripLabel: "Total trip",
        courierTotalLabel: "Total",
        courierYourFeeLabel: "Your fee",
        courierPayLabel: "Pay",
        courierFeeLabel: "Fee",

        courierReadyInLabel: "Ready in",
        courierReadyNow: "READY",

        courierStatusNew: "NEW",
        courierStatusTaken: "TAKEN",
        courierStatusPickedUp: "PICKED UP",
        courierStatusDelivered: "DELIVERED",
        courierStatusCancelled: "CANCELLED",

        courierPickedUpAction: "Picked up",
        courierDeliveredAction: "Delivered",
        courierSaving: "Saving…",
        courierWorking: "Working…",

        courierRouteToRestaurant: "Route to restaurant",
        courierRouteToCustomer: "Route to customer",
        courierYandex: "Yandex",

        courierChat: "Chat",
        courierHideChat: "Hide chat",

        courierAccept: "Accept",
        courierDecline: "Decline",

        courierTipDeliveredAfterPickup: "Tip: “Delivered” becomes available after “Picked up”.",

        courierCompletedOrdersTitle: "Completed orders",
        courierNoCompletedOrders: "No completed orders yet",
        courierDeliveredOrdersShownHint: "Delivered orders are shown here.",

        courierNotAuthorized: "Not authorized",

        courierErrorInitDocs: "Failed to init courier docs",
        courierErrorLoadOffers: "Failed to load offers",
        courierErrorLoadActiveOrders: "Failed to load active orders",
        courierErrorLoadCompletedOrders: "Failed to load completed orders",

        courierErrorCannotOfflineActive: "You can't go OFFLINE while you have active orders.",
        courierErrorUpdateStatus: "Failed to update status",
        courierErrorGeoNotSupported: "Geolocation not supported",
        courierErrorUpdateLocation: "Failed to update location",

        courierErrorOrderNotFound: "Order not found",
        courierErrorOfferNotForYou: "This order offer is not assigned to you",
        courierErrorOrderNotAvailable: "Order is no longer available",
        courierErrorOrderTaken: "Order already taken by another courier",
        courierErrorAcceptOffer: "Failed to accept offer",
        courierErrorOpenChat: "Failed to open chat",

        courierErrorLogoutActive:
            "You can't logout while you have active orders. Finish delivery or ask restaurant to remove you.",

        courierAptShort: "Apt",
        courierEntranceShort: "Entrance",
        courierPaymentCash: "CASH",
        courierPaymentCard: "CARD",

        back: "Back",
        checkingSession: "Checking session…",
        goToLogin: "Go to login",

        pickupSectionTitle: "Restaurant pickup location (Google Places)",
        loadingPickup: "Loading pickup…",
        saved: "Saved",
        changePickupLocation: "Change pickup location",
        pickupPlaceholder: "Pickup address (restaurant) — start typing…",
        savePickupLocation: "Save pickup location",
        saving: "Saving…",
        pickupNeedHint: "Needed to calculate route and select the nearest courier.",
        pickupPickFromSuggestionsError: "Pick the restaurant address from Google suggestions (coordinates are required).",
        errorLoadPickup: "Failed to load restaurant pickup location",
        errorSavePickup: "Failed to save pickup location",

        customerNamePlaceholder: "Customer name",
        customerPhonePlaceholder: "Phone (e.g. 052-1234567)",
        phoneDigitsHint: "Dashes/spaces are fine — we validate by digits.",

        deliverySectionTitle: "Delivery address (Google Places)",
        deliveryPlaceholder: "Delivery address — start typing…",
        deliveryPickHint: "Important: pick an address from Google suggestions — this gives us coordinates + placeId.",
        streetPlaceholder: "Street",
        housePlaceholder: "House #",
        apartmentPlaceholder: "Apartment (optional)",
        entrancePlaceholder: "Entrance (optional)",
        commentPlaceholder: "Delivery comment (intercom/entrance/floor/leave at door)",
        commentHint: "This comment is for delivery instructions only.",

        prepTimeSectionTitle: "Order ready time",
        prepTimeHint: "The courier will see a “ready in …” timer in the offer and active order.",
        minShort: "min",

        paymentTypeLabel: "Payment type",
        paymentHint: "Cash: courier collects money from the customer. Card: customer already paid the restaurant; courier collects ₪0 from customer and receives the delivery fee from the restaurant.",

        subtotalPlaceholder: "Order subtotal (₪) — food cost",

        deliveryFeeAutoLabel: "Delivery fee (auto)",
        calculating: "Calculating…",
        distanceRouteLabel: "Distance (route)",
        etaRouteLabel: "ETA (route)",
        routePickAddressToCalculate: "Pick delivery address from suggestions to calculate the route.",

        orderTotalLabel: "Order total",
        courierKeepsDeliveryFee: "Courier keeps (delivery fee)",

        createOrder: "Create order",
        creating: "Creating…",
        fixHighlightedFields: "Fix the fields highlighted in red.",

        errorPickPrepTime: "Select ready time (20/30/40 minutes).",
        errorCustomerNameRequired: "Enter customer name.",
        errorPhoneMinDigits: "Phone must contain at least 9 digits (usually 10).",
        errorStartTypingAddress: "Start typing the delivery address.",
        errorPickAddressFromSuggestions: "Pick an address from Google suggestions (coordinates + placeId required).",
        errorStreetRequired: "Enter street.",
        errorHouseRequired: "Enter house number.",
        errorSubtotalPositive: "Subtotal must be > 0 (e.g. 100).",
        errorPickupMissing: "Pickup location is required (restaurant address with coordinates).",
        errorCalcRouteFee: "Failed to calculate route / delivery fee",
        errorQuoteMissing: "Could not calculate delivery fee for this route.",

        errorNoAuthRelogin: "No auth session. Please login again.",
        errorSetPickupFirst: "Set the restaurant pickup address first (pick from suggestions so we get coordinates).",
        errorPickDropoffFromSuggestions: "Pick delivery address from Google suggestions so we get coordinates.",
        errorDeliveryFeeNotCalculated: "Delivery fee could not be calculated. Check the address and try again.",
        errorCreateOrder: "Failed to create order",
        errorDailyLimit: "Daily order limit reached (999).",

        restaurantConsole: "Restaurant Console",
        courierConsole: "Courier Console",

        orders: "Orders",
        newOrder: "New order",
        reports: "Reports",
        logout: "Logout",

        language: "Language",

        // общие
        chat: "Chat",
        hideChat: "Hide chat",
        send: "Send",
        typeMessage: "Type message...",
        notAuthorized: "Not authorized",
        loading: "Loading…",

        // timer examples (если захочешь использовать)
        readyIn: "Ready in {time}",
        readyNow: "Ready now",
        readyLateBy: "Ready (late by {time})",
        // ДОБАВЬ В dict.en
        tabActive: "Active",
        tabCompleted: "Completed",
        tabCancelled: "Cancelled",
        total: "Total",
        order: "Order",

        statusNew: "NEW",
        statusOffered: "OFFERED",
        statusTaken: "TAKEN",
        statusPickedUp: "PICKED UP",
        statusDelivered: "DELIVERED",
        statusCancelled: "CANCELLED",

        paymentCash: "CASH",
        paymentCard: "CARD",

        fieldCustomer: "Customer",
        fieldAddress: "Address",
        fieldPhone: "Phone",
        fieldSubtotal: "Subtotal",
        fieldDeliveryFee: "Delivery fee",
        fieldTotal: "Total",

        cashCourierPaysRestaurant: "Courier pays restaurant",
        cashCourierCollectsFromCustomer: "Courier collects from customer",
        cardRestaurantPaysCourier: "Restaurant pays courier",

        created: "Created",
        courier: "Courier",


        noOrdersYet: "No orders yet. Click",
        noAuthSession: "No auth session. Please login.",

        cancelOrder: "Cancel order",
        cancelling: "Cancelling…",
        confirmCancelOrder: "Cancel this order?",

        removeCourier: "Remove courier",
        removing: "Removing…",
        confirmRemoveCourier: "Remove courier from this order and reassign?",

        errorFirestore: "Firestore error",
        errorCancelOrder: "Failed to cancel order",
        errorRemoveCourier: "Failed to remove courier",

        addressApt: "Apt",
        addressEntrance: "Entrance",
        comment: "Comment",

    },
    ru: {
        courierConsoleTitle: "Консоль курьера",
        courierConsoleSubtitle: "Рабочая панель — офферы, активные заказы, этапы доставки.",

        courierOnline: "ОНЛАЙН",
        courierOffline: "ОФФЛАЙН",
        courierGoOnline: "Выйти онлайн",
        courierGoOffline: "Выйти оффлайн",

        courierActiveTab: "Активные",
        courierCompletedTab: "Выполненные",

        courierActiveOrderTitle: "Активный заказ",
        courierNewOffersTitle: "Новые офферы",
        courierNoNewOffers: "Нет новых офферов",
        courierActiveCountLabel: "Активно",
        courierMaxActiveReached: "Достигнут лимит активных заказов:",
        courierPresenceHint: "Статус обновляется, пока приложение открыто.",

        courierOrderLabel: "Заказ",
        courierCustomerLabel: "Клиент",
        courierPhoneLabel: "Телефон",
        courierAddressLabel: "Адрес",
        courierToRestaurantLabel: "До ресторана",
        courierPickupToDropoffLabel: "Ресторан → клиент",
        courierTotalTripLabel: "Всего путь",
        courierTotalLabel: "Итого",
        courierYourFeeLabel: "Твой заработок",
        courierPayLabel: "Оплата",
        courierFeeLabel: "Оплата",

        courierReadyInLabel: "Готово через",
        courierReadyNow: "ГОТОВО",

        courierStatusNew: "НОВЫЙ",
        courierStatusTaken: "ВЗЯТ",
        courierStatusPickedUp: "ЗАБРАЛ",
        courierStatusDelivered: "ДОСТАВЛЕНО",
        courierStatusCancelled: "ОТМЕНЁН",

        courierPickedUpAction: "Забрал заказ",
        courierDeliveredAction: "Доставлено",
        courierSaving: "Сохраняем…",
        courierWorking: "Обрабатываем…",

        courierRouteToRestaurant: "Маршрут в ресторан",
        courierRouteToCustomer: "Маршрут к клиенту",
        courierYandex: "Яндекс",

        courierChat: "Чат",
        courierHideChat: "Скрыть чат",

        courierAccept: "Принять",
        courierDecline: "Отклонить",

        courierTipDeliveredAfterPickup: "Подсказка: “Доставлено” станет доступно после “Забрал заказ”.",

        courierCompletedOrdersTitle: "Выполненные заказы",
        courierNoCompletedOrders: "Пока нет выполненных заказов",
        courierDeliveredOrdersShownHint: "Здесь отображаются доставленные заказы.",

        courierNotAuthorized: "Нет доступа",

        courierErrorInitDocs: "Не удалось инициализировать профиль курьера",
        courierErrorLoadOffers: "Не удалось загрузить офферы",
        courierErrorLoadActiveOrders: "Не удалось загрузить активные заказы",
        courierErrorLoadCompletedOrders: "Не удалось загрузить выполненные заказы",

        courierErrorCannotOfflineActive: "Нельзя уйти OFFLINE, пока есть активные заказы.",
        courierErrorUpdateStatus: "Не удалось обновить статус",
        courierErrorGeoNotSupported: "Геолокация не поддерживается",
        courierErrorUpdateLocation: "Не удалось обновить локацию",

        courierErrorOrderNotFound: "Заказ не найден",
        courierErrorOfferNotForYou: "Этот оффер не назначен тебе",
        courierErrorOrderNotAvailable: "Заказ больше недоступен",
        courierErrorOrderTaken: "Заказ уже взял другой курьер",
        courierErrorAcceptOffer: "Не удалось принять оффер",
        courierErrorOpenChat: "Не удалось открыть чат",

        courierErrorLogoutActive:
            "Нельзя выйти из аккаунта, пока есть активные заказы. Заверши доставку или попроси ресторан снять тебя.",

        courierAptShort: "Кв.",
        courierEntranceShort: "Вход",
        courierPaymentCash: "НАЛ",
        courierPaymentCard: "КАРТА",

        back: "Назад",
        checkingSession: "Проверяем сессию…",
        goToLogin: "К логину",

        pickupSectionTitle: "Адрес ресторана (пикап) — Google Places",
        loadingPickup: "Загрузка pickup…",
        saved: "Сохранено",
        changePickupLocation: "Изменить pickup",
        pickupPlaceholder: "Pickup адрес (ресторан) — начни ввод…",
        savePickupLocation: "Сохранить pickup",
        saving: "Сохранение…",
        pickupNeedHint: "Нужно для расчёта маршрута и выбора ближайшего курьера.",
        pickupPickFromSuggestionsError: "Выбери адрес ресторана из подсказок Google (нужны координаты).",
        errorLoadPickup: "Не удалось загрузить pickup адрес ресторана",
        errorSavePickup: "Не удалось сохранить pickup адрес",

        customerNamePlaceholder: "Имя клиента",
        customerPhonePlaceholder: "Телефон (например 052-1234567)",
        phoneDigitsHint: "Можно с тире/пробелами — проверяем по цифрам.",

        deliverySectionTitle: "Адрес доставки — Google Places",
        deliveryPlaceholder: "Адрес доставки — начни ввод…",
        deliveryPickHint: "Важно: выбери адрес из подсказок Google — так мы получим координаты + placeId.",
        streetPlaceholder: "Улица",
        housePlaceholder: "Дом №",
        apartmentPlaceholder: "Квартира (необязательно)",
        entrancePlaceholder: "Подъезд/вход (необязательно)",
        commentPlaceholder: "Комментарий к доставке (домофон/подъезд/этаж/оставить у двери)",
        commentHint: "Комментарий относится только к доставке.",

        prepTimeSectionTitle: "Время готовности заказа",
        prepTimeHint: "Курьер увидит таймер “готово через …” в оффере и в активном заказе.",
        minShort: "мин",

        paymentTypeLabel: "Тип оплаты",
        paymentHint: "Cash: курьер берёт деньги у клиента. Card: клиент оплатил ресторану; курьер денег у клиента не берёт и получает delivery fee в ресторане.",

        subtotalPlaceholder: "Сумма заказа (₪) — стоимость еды",

        deliveryFeeAutoLabel: "Стоимость доставки (авто)",
        calculating: "Считаем…",
        distanceRouteLabel: "Дистанция (маршрут)",
        etaRouteLabel: "Время (маршрут)",
        routePickAddressToCalculate: "Выбери адрес доставки из подсказок, чтобы рассчитать маршрут.",

        orderTotalLabel: "Итого",
        courierKeepsDeliveryFee: "Курьер оставляет себе (доставка)",

        createOrder: "Создать заказ",
        creating: "Создаём…",
        fixHighlightedFields: "Исправь поля, подсвеченные красным.",

        errorPickPrepTime: "Выбери время готовности (20/30/40 минут).",
        errorCustomerNameRequired: "Укажи имя клиента.",
        errorPhoneMinDigits: "Телефон должен содержать минимум 9 цифр (обычно 10).",
        errorStartTypingAddress: "Начни вводить адрес доставки.",
        errorPickAddressFromSuggestions: "Выбери адрес из подсказок Google (нужны координаты и placeId).",
        errorStreetRequired: "Укажи улицу.",
        errorHouseRequired: "Укажи номер дома.",
        errorSubtotalPositive: "Стоимость заказа должна быть > 0 (например 100).",
        errorPickupMissing: "Нужен pickup адрес ресторана (с координатами).",
        errorCalcRouteFee: "Не удалось рассчитать маршрут / стоимость доставки",
        errorQuoteMissing: "Не удалось рассчитать стоимость доставки по маршруту.",

        errorNoAuthRelogin: "Нет авторизации. Перелогинься.",
        errorSetPickupFirst: "Сначала укажи pickup-адрес ресторана (из подсказок), чтобы были координаты.",
        errorPickDropoffFromSuggestions: "Выбери адрес доставки из подсказок Google, чтобы были координаты.",
        errorDeliveryFeeNotCalculated: "Не удалось рассчитать delivery fee. Проверь адрес и попробуй ещё раз.",
        errorCreateOrder: "Не удалось создать заказ",
        errorDailyLimit: "Достигнут дневной лимит заказов (999).",

        restaurantConsole: "Консоль ресторана",
        courierConsole: "Консоль курьера",

        orders: "Заказы",
        newOrder: "Новый заказ",
        reports: "Отчёты",
        logout: "Выйти",

        language: "Язык",

        // общие
        chat: "Чат",
        hideChat: "Скрыть чат",
        send: "Отправить",
        typeMessage: "Введите сообщение...",
        notAuthorized: "Нет доступа",
        loading: "Загрузка…",

        // timer examples
        readyIn: "Готово через {time}",
        readyNow: "Готово",
        readyLateBy: "Готово ({time} назад)",
        // ДОБАВЬ В dict.ru
        tabActive: "Активные",
        tabCompleted: "Выполненные",
        tabCancelled: "Отменённые",
        total: "Всего",
        order: "Заказ",

        statusNew: "НОВЫЙ",
        statusOffered: "ПРЕДЛОЖЕН",
        statusTaken: "ВЗЯТ",
        statusPickedUp: "ЗАБРАЛ",
        statusDelivered: "ДОСТАВЛЕН",
        statusCancelled: "ОТМЕНЁН",

        paymentCash: "НАЛИЧНЫЕ",
        paymentCard: "КАРТОЙ",

        fieldCustomer: "Клиент",
        fieldAddress: "Адрес",
        fieldPhone: "Телефон",
        fieldSubtotal: "Сумма",
        fieldDeliveryFee: "Доставка",
        fieldTotal: "Итого",

        cashCourierPaysRestaurant: "Курьер платит ресторану",
        cashCourierCollectsFromCustomer: "Курьер получает от клиента",
        cardRestaurantPaysCourier: "Ресторан платит курьеру",

        created: "Создан",
        courier: "Курьер",


        noOrdersYet: "Пока нет заказов. Нажмите",
        noAuthSession: "Нет сессии. Пожалуйста, войдите.",

        cancelOrder: "Отменить заказ",
        cancelling: "Отмена…",
        confirmCancelOrder: "Отменить этот заказ?",

        removeCourier: "Убрать курьера",
        removing: "Убираем…",
        confirmRemoveCourier: "Убрать курьера из заказа и заново назначить?",

        errorFirestore: "Ошибка Firestore",
        errorCancelOrder: "Не удалось отменить заказ",
        errorRemoveCourier: "Не удалось убрать курьера",

        addressApt: "Кв.",
        addressEntrance: "Вход",
        comment: "Комментарий",

    },
    he: {
        courierConsoleTitle: "קונסולת שליח",
        courierConsoleSubtitle: "לוח עבודה — הצעות, הזמנות פעילות, שלבי משלוח.",

        courierOnline: "מחובר",
        courierOffline: "מנותק",
        courierGoOnline: "התחבר",
        courierGoOffline: "התנתק",

        courierActiveTab: "פעילים",
        courierCompletedTab: "הושלמו",

        courierActiveOrderTitle: "הזמנה פעילה",
        courierNewOffersTitle: "הצעות חדשות",
        courierNoNewOffers: "אין הצעות חדשות",
        courierActiveCountLabel: "פעילים",
        courierMaxActiveReached: "הגעת למקסימום הזמנות פעילות:",
        courierPresenceHint: "הנוכחות מתעדכנת בזמן שהאפליקציה פתוחה.",

        courierOrderLabel: "הזמנה",
        courierCustomerLabel: "לקוח",
        courierPhoneLabel: "טלפון",
        courierAddressLabel: "כתובת",
        courierToRestaurantLabel: "למסעדה",
        courierPickupToDropoffLabel: "איסוף → מסירה",
        courierTotalTripLabel: "סה״כ דרך",
        courierTotalLabel: "סך הכל",
        courierYourFeeLabel: "העמלה שלך",
        courierPayLabel: "תשלום",
        courierFeeLabel: "עמלה",

        courierReadyInLabel: "מוכן בעוד",
        courierReadyNow: "מוכן",

        courierStatusNew: "חדש",
        courierStatusTaken: "נלקח",
        courierStatusPickedUp: "נאסף",
        courierStatusDelivered: "נמסר",
        courierStatusCancelled: "בוטל",

        courierPickedUpAction: "אספתי הזמנה",
        courierDeliveredAction: "נמסר",
        courierSaving: "שומר…",
        courierWorking: "מבצע…",

        courierRouteToRestaurant: "מסלול למסעדה",
        courierRouteToCustomer: "מסלול ללקוח",
        courierYandex: "יאנדקס",

        courierChat: "צ׳אט",
        courierHideChat: "הסתר צ׳אט",

        courierAccept: "קבל",
        courierDecline: "דחה",

        courierTipDeliveredAfterPickup: "טיפ: “נמסר” זמין אחרי “אספתי הזמנה”.",

        courierCompletedOrdersTitle: "הזמנות שהושלמו",
        courierNoCompletedOrders: "אין עדיין הזמנות שהושלמו",
        courierDeliveredOrdersShownHint: "כאן מוצגות הזמנות שנמסרו.",

        courierNotAuthorized: "לא מורשה",

        courierErrorInitDocs: "לא ניתן לאתחל מסמכי שליח",
        courierErrorLoadOffers: "לא ניתן לטעון הצעות",
        courierErrorLoadActiveOrders: "לא ניתן לטעון הזמנות פעילות",
        courierErrorLoadCompletedOrders: "לא ניתן לטעון הזמנות שהושלמו",

        courierErrorCannotOfflineActive: "אי אפשר להתנתק כשיש הזמנות פעילות.",
        courierErrorUpdateStatus: "לא ניתן לעדכן סטטוס",
        courierErrorGeoNotSupported: "מיקום לא נתמך",
        courierErrorUpdateLocation: "לא ניתן לעדכן מיקום",

        courierErrorOrderNotFound: "הזמנה לא נמצאה",
        courierErrorOfferNotForYou: "ההצעה הזו לא הוקצתה לך",
        courierErrorOrderNotAvailable: "ההזמנה כבר לא זמינה",
        courierErrorOrderTaken: "ההזמנה כבר נלקחה ע״י שליח אחר",
        courierErrorAcceptOffer: "לא ניתן לקבל הצעה",
        courierErrorOpenChat: "לא ניתן לפתוח צ׳אט",

        courierErrorLogoutActive:
            "אי אפשר להתנתק כשיש הזמנות פעילות. סיים משלוח או בקש מהמסעדה להסיר אותך.",

        courierAptShort: "דירה",
        courierEntranceShort: "כניסה",
        courierPaymentCash: "מזומן",
        courierPaymentCard: "כרטיס",

        back: "חזרה",
        checkingSession: "בודק חיבור…",
        goToLogin: "לעמוד התחברות",

        pickupSectionTitle: "נקודת איסוף במסעדה (Google Places)",
        loadingPickup: "טוען נקודת איסוף…",
        saved: "נשמר",
        changePickupLocation: "שנה נקודת איסוף",
        pickupPlaceholder: "כתובת איסוף (מסעדה) — התחל להקליד…",
        savePickupLocation: "שמור נקודת איסוף",
        saving: "שומר…",
        pickupNeedHint: "נדרש לחישוב מסלול ולבחירת השליח הקרוב ביותר.",
        pickupPickFromSuggestionsError: "בחר כתובת מסעדה מההצעות של Google (נדרשות קואורדינטות).",
        errorLoadPickup: "לא ניתן לטעון כתובת איסוף של המסעדה",
        errorSavePickup: "לא ניתן לשמור נקודת איסוף",

        customerNamePlaceholder: "שם הלקוח",
        customerPhonePlaceholder: "טלפון (לדוג׳ 052-1234567)",
        phoneDigitsHint: "אפשר מקפים/רווחים — הבדיקה לפי ספרות בלבד.",

        deliverySectionTitle: "כתובת משלוח (Google Places)",
        deliveryPlaceholder: "כתובת משלוח — התחל להקליד…",
        deliveryPickHint: "חשוב: בחר כתובת מההצעות של Google — כך נקבל קואורדינטות ו‑placeId.",
        streetPlaceholder: "רחוב",
        housePlaceholder: "מס׳ בית",
        apartmentPlaceholder: "דירה (לא חובה)",
        entrancePlaceholder: "כניסה (לא חובה)",
        commentPlaceholder: "הערת משלוח (אינטרקום/כניסה/קומה/להשאיר ליד הדלת)",
        commentHint: "ההערה מיועדת להנחיות משלוח בלבד.",

        prepTimeSectionTitle: "זמן מוכן להזמנה",
        prepTimeHint: "השליח יראה טיימר “מוכן בעוד …” בהצעה ובהזמנה פעילה.",
        minShort: "דק׳",

        paymentTypeLabel: "אמצעי תשלום",
        paymentHint: "מזומן: השליח גובה מהלקוח. כרטיס: הלקוח כבר שילם למסעדה; השליח גובה ₪0 מהלקוח ומקבל את דמי המשלוח מהמסעדה.",

        subtotalPlaceholder: "סכום ביניים (₪) — מחיר האוכל",

        deliveryFeeAutoLabel: "דמי משלוח (אוטומטי)",
        calculating: "מחשב…",
        distanceRouteLabel: "מרחק (מסלול)",
        etaRouteLabel: "זמן משוער (מסלול)",
        routePickAddressToCalculate: "בחר כתובת משלוח מההצעות כדי לחשב מסלול.",

        orderTotalLabel: "סך הכל",
        courierKeepsDeliveryFee: "השליח שומר (דמי משלוח)",

        createOrder: "צור הזמנה",
        creating: "יוצר…",
        fixHighlightedFields: "תקן את השדות המסומנים באדום.",

        errorPickPrepTime: "בחר זמן מוכן (20/30/40 דקות).",
        errorCustomerNameRequired: "הזן שם לקוח.",
        errorPhoneMinDigits: "מספר טלפון חייב לכלול לפחות 9 ספרות (בדרך כלל 10).",
        errorStartTypingAddress: "התחל להקליד כתובת משלוח.",
        errorPickAddressFromSuggestions: "בחר כתובת מההצעות של Google (נדרשים קואורדינטות ו‑placeId).",
        errorStreetRequired: "הזן רחוב.",
        errorHouseRequired: "הזן מספר בית.",
        errorSubtotalPositive: "הסכום חייב להיות גדול מ‑0 (למשל 100).",
        errorPickupMissing: "נדרשת כתובת איסוף (כתובת מסעדה עם קואורדינטות).",
        errorCalcRouteFee: "לא ניתן לחשב מסלול / דמי משלוח",
        errorQuoteMissing: "לא הצלחנו לחשב דמי משלוח עבור המסלול.",

        errorNoAuthRelogin: "אין חיבור. אנא התחבר מחדש.",
        errorSetPickupFirst: "קבע קודם כתובת איסוף של המסעדה (בחר מההצעות כדי שנקבל קואורדינטות).",
        errorPickDropoffFromSuggestions: "בחר כתובת משלוח מההצעות של Google כדי שנקבל קואורדינטות.",
        errorDeliveryFeeNotCalculated: "לא ניתן לחשב דמי משלוח. בדוק את הכתובת ונסה שוב.",
        errorCreateOrder: "לא ניתן ליצור הזמנה",
        errorDailyLimit: "הגעת למגבלת הזמנות יומית (999).",

        restaurantConsole: "קונסולת מסעדה",
        courierConsole: "קונסולת שליח",

        orders: "הזמנות",
        newOrder: "הזמנה חדשה",
        reports: "דוחות",
        logout: "התנתקות",

        language: "שפה",

        // общие
        chat: "צ׳אט",
        hideChat: "הסתר צ׳אט",
        send: "שלח",
        typeMessage: "הקלד הודעה...",
        notAuthorized: "אין הרשאה",
        loading: "טוען…",

        // timer examples
        readyIn: "מוכן בעוד {time}",
        readyNow: "מוכן עכשיו",
        readyLateBy: "מוכן (איחור {time})",
        // ДОБАВЬ В dict.he
        tabActive: "פעילים",
        tabCompleted: "הושלמו",
        tabCancelled: "בוטלו",
        total: 'סה"כ',
        order: "הזמנה",

        statusNew: "חדש",
        statusOffered: "הוצע",
        statusTaken: "נלקח",
        statusPickedUp: "נאסף",
        statusDelivered: "נמסר",
        statusCancelled: "בוטל",

        paymentCash: "מזומן",
        paymentCard: "כרטיס",

        fieldCustomer: "לקוח",
        fieldAddress: "כתובת",
        fieldPhone: "טלפון",
        fieldSubtotal: "סכום ביניים",
        fieldDeliveryFee: "דמי משלוח",
        fieldTotal: 'סה"כ',

        cashCourierPaysRestaurant: "שליח משלם למסעדה",
        cashCourierCollectsFromCustomer: "שליח גובה מהלקוח",
        cardRestaurantPaysCourier: "המסעדה משלמת לשליח",

        created: "נוצר",
        courier: "שליח",


        noOrdersYet: "אין הזמנות עדיין. לחץ",
        noAuthSession: "אין חיבור. אנא התחבר.",

        cancelOrder: "בטל הזמנה",
        cancelling: "מבטל…",
        confirmCancelOrder: "לבטל את ההזמנה?",

        removeCourier: "הסר שליח",
        removing: "מסיר…",
        confirmRemoveCourier: "להסיר שליח מההזמנה ולהקצות מחדש?",

        errorFirestore: "שגיאת Firestore",
        errorCancelOrder: "לא ניתן לבטל הזמנה",
        errorRemoveCourier: "לא ניתן להסיר שליח",

        addressApt: "דירה",
        addressEntrance: "כניסה",
        comment: "הערה",

    },
} as const;

type Key = keyof typeof dict.en;

type TParams = Record<string, string | number | undefined | null>;

type I18nCtx = {
    lang: Lang;
    dir: Dir;
    setLang: (l: Lang) => void;
    t: (k: Key, params?: TParams) => string;
};

const Ctx = createContext<I18nCtx | null>(null);

function normalizeLang(x: any): Lang | null {
    return x === "en" || x === "ru" || x === "he" ? x : null;
}

function interpolate(template: string, params?: TParams) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, key) => {
        const v = params[key];
        return v === undefined || v === null ? "" : String(v);
    });
}

/**
 * =========================
 * I18nProvider — отвечает только за:
 * - хранение lang (localStorage)
 * - rtl (html dir + body class)
 * - t()
 * =========================
 */
export function I18nProvider({
                                 children,
                                 defaultLang = "en",
                             }: {
    children: ReactNode;

    defaultLang?: Lang;
}) {
    const [lang, setLangState] = useState<Lang>(() => {
        const saved = normalizeLang(localStorage.getItem(STORAGE_KEY));
        return saved ?? defaultLang;
    });

    const dir: Dir = lang === "he" ? "rtl" : "ltr";

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, lang);

        // RTL + доступность
        document.documentElement.lang = lang;
        document.documentElement.dir = dir;

        // удобно для CSS
        document.body.classList.toggle("rtl", dir === "rtl");
    }, [lang, dir]);

    const api = useMemo<I18nCtx>(() => {
        return {
            lang,
            dir,
            setLang: (l) => setLangState(l),
            t: (k, params) => {
                const base = (dict[lang]?.[k] ?? dict.en[k] ?? String(k)) as string;
                return interpolate(base, params);
            },
        };
    }, [lang, dir]);

    return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useI18n() {
    const ctx = useContext(Ctx);
    if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
    return ctx;
}

/**
 * =========================
 * I18nProfileSync — синхронизация с Firestore профилем
 * - restaurants/{uid}.lang
 * - couriers/{uid}.lang
 *
 * КУДА ДОБАВЛЯТЬ:
 * - В Restaurant layout: <I18nProfileSync scope="restaurant" />
 * - В Courier layout/страницу: <I18nProfileSync scope="courier" />
 * =========================
 */
function collectionForScope(scope: "restaurant" | "courier") {
    return scope === "restaurant" ? "restaurants" : "couriers";
}

// если хочешь без scope — можно автоопределять по URL
function scopeFromPath(pathname: string): "restaurant" | "courier" | null {
    if (pathname.startsWith("/restaurant")) return "restaurant";
    if (pathname.startsWith("/courier")) return "courier";
    return null;
}

export function I18nProfileSync(props: { scope?: "restaurant" | "courier" }) {
    const { lang, setLang } = useI18n();
    const location = useLocation();

    const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);

    // чтобы в snapshot сравнивать с актуальным lang
    const langRef = useRef(lang);
    useEffect(() => {
        langRef.current = lang;
    }, [lang]);

    // флаг: сейчас применяем язык из профиля -> не надо писать обратно
    const applyingFromProfileRef = useRef(false);

    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
        return () => unsub();
    }, []);

    const scope =
        props.scope ??
        scopeFromPath(location.pathname);

    // 1) Читаем язык из профиля и применяем
    useEffect(() => {
        if (!uid || !scope) return;

        const col = collectionForScope(scope);
        const ref = doc(db, col, uid);

        const unsub = onSnapshot(
            ref,
            (snap) => {
                const data: any = snap.data();
                const profileLang = normalizeLang(data?.lang);

                if (profileLang) {
                    if (profileLang !== langRef.current) {
                        applyingFromProfileRef.current = true;
                        setLang(profileLang);

                        // оставим флаг true до следующего тика,
                        // чтобы эффект записи не сработал “в ответ”
                        window.setTimeout(() => {
                            applyingFromProfileRef.current = false;
                        }, 0);
                    }
                } else {
                    // если поля нет — запишем текущее (MVP)
                    setDoc(ref, { lang: langRef.current }, { merge: true }).catch(() => {});
                }
            },
            () => {}
        );

        return () => unsub();
    }, [uid, scope, setLang]);

    // 2) При смене языка пользователем — пишем в профиль
    useEffect(() => {
        if (!uid || !scope) return;
        if (applyingFromProfileRef.current) return;

        const col = collectionForScope(scope);
        const ref = doc(db, col, uid);

        updateDoc(ref, { lang }).catch(() => {
            // если документа нет — создадим
            setDoc(ref, { lang }, { merge: true }).catch(() => {});
        });
    }, [uid, scope, lang]);

    return null;
}
