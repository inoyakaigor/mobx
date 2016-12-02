import {ObservableValue, UNCHANGED} from "./observablevalue";
import {isComputedValue, ComputedValue} from "../core/computedvalue";
import {isAction} from "../api/action";
import {createInstanceofPredicate, isObject, Lambda, getNextId, invariant, assertPropertyConfigurable, isPlainObject, addHiddenFinalProp, deprecated} from "../utils/utils";
import {runLazyInitializers} from "../utils/decorators";
import {hasInterceptors, IInterceptable, registerInterceptor, interceptChange} from "./intercept-utils";
import {IListenable, registerListener, hasListeners, notifyListeners} from "./listen-utils";
import {isSpyEnabled, spyReportStart, spyReportEnd} from "../core/spy";
import {IModifier, isModifierDescriptor, IModifierDescriptor, modifiers} from "../types/modifiers";

export interface IObservableObject {
	"observable-object": IObservableObject;
}

// In 3.0, change to IObjectDidChange
export interface IObjectChange {
	name: string;
	object: any;
	type: "update" | "add";
	oldValue?: any;
	newValue: any;
}

export interface IObjectWillChange {
	object: any;
	type: "update" | "add";
	name: string;
	newValue: any;
}

export class ObservableObjectAdministration implements IInterceptable<IObjectWillChange>, IListenable {
	values: {[key: string]: ObservableValue<any>|ComputedValue<any>} = {};
	changeListeners = null;
	interceptors = null;

	constructor(public target: any, public name: string) { }

	/**
		* Observes this object. Triggers for the events 'add', 'update' and 'delete'.
		* See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/observe
		* for callback details
		*/
	observe(callback: (changes: IObjectChange) => void, fireImmediately?: boolean): Lambda {
		invariant(fireImmediately !== true, "`observe` doesn't support the fire immediately property for observable objects.");
		return registerListener(this, callback);
	}


	intercept(handler): Lambda {
		return registerInterceptor(this, handler);
	}
}

export interface IIsObservableObject {
	$mobx: ObservableObjectAdministration;
}

export function asObservableObject(target, name?: string): ObservableObjectAdministration {
	if (isObservableObject(target))
		return (target as any).$mobx;

	if (!isPlainObject(target))
		name = (target.constructor.name || "ObservableObject") + "@" + getNextId();
	if (!name)
		name = "ObservableObject@" + getNextId();

	const adm = new ObservableObjectAdministration(target, name);
	addHiddenFinalProp(target, "$mobx", adm);
	return adm;
}

export function setObservableObjectInstanceProperty(adm: ObservableObjectAdministration, propName: string, descriptor: PropertyDescriptor, defaultModifier: IModifier<any, any>) {
	if (adm.values[propName]) {
		invariant("value" in descriptor, "cannot redefine property " + propName);
		adm.target[propName] = descriptor.value; // the property setter will make 'value' reactive if needed.
	} else {
		if ("value" in descriptor) {
			if (isModifierDescriptor(descriptor.value)) {
				const modifierDescriptor = descriptor.value as IModifierDescriptor<any, any>;
				defineObservableProperty(adm, propName, false, modifierDescriptor.initialValue, modifierDescriptor.modifier, true, undefined);
			}
			else {
				// without modifier, use the default
				defineObservableProperty(adm, propName, false, descriptor.value, defaultModifier, true, undefined);
			}
		} else {
			defineObservableProperty(adm, propName, true, descriptor.get, modifiers.ref, true, descriptor.set);
		}
	}
}

export function defineObservableProperty(adm: ObservableObjectAdministration, propName: string, computed: boolean, newValue, modifier: IModifier<any, any>, asInstanceProperty: boolean, setter) {
	if (asInstanceProperty)
		assertPropertyConfigurable(adm.target, propName);

	let observable: ComputedValue<any>|ObservableValue<any>;
	let name = `${adm.name}.${propName}`;
	let isComputed = true;

	if (isComputedValue(newValue)) {
		// desugar computed(getter, setter)
		observable = newValue;
		newValue.name = name;
		if (!newValue.scope)
			newValue.scope = adm.target;
	} else if (isModifierDescriptor(newValue) && newValue.modifier === modifiers.structure && typeof newValue.initialValue === "function" && newValue.initialValue.length === 0) {
		// TODO: rewrite to modifier
		observable = new ComputedValue(newValue.initialValue, adm.target, true, name, setter);
	} else if (computed) {
		// TODO: blegh, simplify all this!
		observable = new ComputedValue(newValue, adm.target, false, name, setter);
	} else {
		isComputed = false;
		if (hasInterceptors(adm)) {
			const change = interceptChange<IObjectWillChange>(adm, {
				object: adm.target,
				name: propName,
				type: "add",
				newValue
			});
			if (!change)
				return;
			newValue = change.newValue;
		}
		observable = new ObservableValue(newValue, modifier, name, false);
		newValue = (observable as any).value; // observableValue might have changed it
	}

	adm.values[propName] = observable;
	if (asInstanceProperty) {
		Object.defineProperty(adm.target, propName, isComputed ? generateComputedPropConfig(propName) : generateObservablePropConfig(propName));
	}
	if (!isComputed)
		notifyPropertyAddition(adm, adm.target, propName, newValue);
}

const observablePropertyConfigs = {};
const computedPropertyConfigs = {};

export function generateObservablePropConfig(propName) {
	const config = observablePropertyConfigs[propName];
	if (config)
		return config;
	return observablePropertyConfigs[propName] = {
		configurable: true,
		enumerable: true,
		get: function() {
			return this.$mobx.values[propName].get();
		},
		set: function(v) {
			setPropertyValue(this, propName, v);
		}
	};
}

export function generateComputedPropConfig(propName) {
	const config = computedPropertyConfigs[propName];
	if (config)
		return config;
	return computedPropertyConfigs[propName] = {
		configurable: true,
		enumerable: false,
		get: function() {
			return this.$mobx.values[propName].get();
		},
		set: function(v) {
			return this.$mobx.values[propName].set(v);
		}
	};
}

export function setPropertyValue(instance, name: string, newValue) {
	const adm = instance.$mobx;
	const observable = adm.values[name];

	// intercept
	if (hasInterceptors(adm)) {
		const change = interceptChange<IObjectWillChange>(adm, {
			type: "update",
			object: instance,
			name, newValue
		});
		if (!change)
			return;
		newValue = change.newValue;
	}
	newValue = observable.prepareNewValue(newValue);

	// notify spy & observers
	if (newValue !== UNCHANGED) {
		const notify = hasListeners(adm);
		const notifySpy = isSpyEnabled();
		const change = notify || notifySpy ? {
				type: "update",
				object: instance,
				oldValue: (observable as any).value,
				name, newValue
			} : null;

		if (notifySpy)
			spyReportStart(change);
		observable.setNewValue(newValue);
		if (notify)
			notifyListeners(adm, change);
		if (notifySpy)
			spyReportEnd();
	}
}

function notifyPropertyAddition(adm, object, name: string, newValue) {
	const notify = hasListeners(adm);
	const notifySpy = isSpyEnabled();
	const change = notify || notifySpy ? {
			type: "add",
			object, name, newValue
		} : null;

	if (notifySpy)
		spyReportStart(change);
	if (notify)
		notifyListeners(adm, change);
	if (notifySpy)
		spyReportEnd();
}


const isObservableObjectAdministration = createInstanceofPredicate("ObservableObjectAdministration", ObservableObjectAdministration);

export function isObservableObject(thing: any): thing is IObservableObject {
	if (isObject(thing)) {
		// Initializers run lazily when transpiling to babel, so make sure they are run...
		runLazyInitializers(thing);
		return isObservableObjectAdministration((thing as any).$mobx);
	}
	return false;
}
