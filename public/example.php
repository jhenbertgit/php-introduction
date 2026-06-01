<?php

// Simple Array
$persons = [
    'John',
    'Jane',
    'Maria'
];

$cars = [
    'Toyota',
    'Honda',
    'Ford'
];

// var_dump($person);

// Array Functions
// array_all
$isTrue = array_all($persons, function ($value) {
    return strlen($value) > 0;
});

$result = array_combine($persons, $cars);
var_dump($result);

// Object
class Person
{
    public string $name;
    public int $age;
    public string $city;

    public function __construct(string $name, int $age, string $city)
    {
        $this->name = $name;
        $this->age = $age;
        $this->city = $city;
    }
}

$person = new Person('John', 30, 'New York');
var_dump($person);


